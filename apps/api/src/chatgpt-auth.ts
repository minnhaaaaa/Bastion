import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { piModelCatalog, customModelFromEnv, type CustomModel } from "@bastion/runtime-pi";
import { eq, and } from "drizzle-orm";
import { schema } from "@bastion/db";
import { HttpError } from "./errors";
import { ProviderConnections, type ProviderSecret } from "./provider-connections";

class SignInFailure extends Error {}

type ChatSecret = Extract<ProviderSecret, { kind: "chatgpt" }>;
const HTTPS = z.string().url().refine(value => { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password; });
export const ChatGPTConfig = z.object({ issuer: HTTPS, authorizeUrl: HTTPS, tokenUrl: HTTPS, jwksUrl: HTTPS, resource: HTTPS, redirectUri: z.string().url(), hostId: z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Use urn:uuid: followed by a stable UUIDv4 for this host"), attemptTtlMs: z.number().int().positive(), maxPending: z.number().int().positive() }).strict();
type Config = z.infer<typeof ChatGPTConfig>;
type ModelChoice = { id: string; name: string; metadata?: CustomModel };
type Attempt = { owner: string; label: string; state: string; nonce: string; verifier: string; expires: number; status: "pending" | "exchanging" | "choose-model" | "connected" | "failed"; models?: ModelChoice[]; secret?: ChatSecret; error?: string; connection?: ReturnType<ProviderConnections["public"]>; previous?: { id: string; model: string; secret: ChatSecret } };
const TokenResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(), id_token: z.string().min(1).optional(), scope: z.string().optional(), token_type: z.string().refine(v => v.toLowerCase() === "bearer") });

/** Local desktop OAuth: credentials never pass through the web client or Pi's CLI auth file. */
export class ChatGPTAuth {
  private attempts = new Map<string, Attempt>();
  private keys: JWTVerifyGetKey;
  private timer: ReturnType<typeof setInterval>;
  private accountModelConfig?: CustomModel;
  constructor(readonly config: Config, private connections: ProviderConnections, private request: typeof fetch = fetch, keys?: JWTVerifyGetKey, accountModelConfig?: CustomModel) {
    if (accountModelConfig) {
      this.accountModelConfig = customModelFromEnv(JSON.stringify(accountModelConfig));
      if (this.accountModelConfig.api !== "openai-responses") throw new Error("CHATGPT_MODEL_CONFIG must use openai-responses");
    }
    this.config = ChatGPTConfig.parse(config);
    this.keys = keys ?? createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: connections.controller.timeoutMs });
    connections.refresh = secret => this.refresh(secret);
    this.timer = setInterval(() => this.prune(), config.attemptTtlMs);
    this.timer.unref();
  }
  static fromEnv(env: NodeJS.ProcessEnv, connections: ProviderConnections) {
    if (!env.CHATGPT_OAUTH_CONFIG) return undefined;
    const config = ChatGPTConfig.parse(JSON.parse(env.CHATGPT_OAUTH_CONFIG));
    const callback = new URL(config.redirectUri);
    if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.pathname !== "/auth/chatgpt/callback" || callback.search || callback.hash || callback.username || callback.password || Number(callback.port) !== Number(env.API_PORT)) throw new Error("CHATGPT_OAUTH_CONFIG.redirectUri must use the API port and http://127.0.0.1:<port>/auth/chatgpt/callback");
    return new ChatGPTAuth(config, connections, fetch, undefined, env.CHATGPT_MODEL_CONFIG ? customModelFromEnv(env.CHATGPT_MODEL_CONFIG) : undefined);
  }
  close() { clearInterval(this.timer); this.attempts.clear(); }
  private prune() { for (const [id, attempt] of this.attempts) if (attempt.expires <= Date.now()) this.attempts.delete(id); }
  private own(owner: string, id: string) {
    this.prune(); const attempt = this.attempts.get(id);
    if (!attempt || attempt.owner !== owner) throw new HttpError("NOT_FOUND", "Sign-in expired or not found. Start again.");
    return attempt;
  }
  async start(owner: string, label: string, connectionId?: string) {
    this.prune();
    if (this.attempts.size >= this.config.maxPending) throw new HttpError("RATE_LIMITED", "Too many pending sign-ins. Wait for an earlier attempt to expire.");
    let previous: Attempt["previous"];
    if (connectionId) {
      const row = await this.connections.own(owner, connectionId), secret = this.connections.open(row);
      if (secret.kind !== "chatgpt") throw new HttpError("VALIDATION", "Choose a ChatGPT connection");
      previous = { id: row.id, model: row.model, secret };
    }
    const id = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    this.attempts.set(id, { owner, label, state, nonce, verifier, expires: Date.now() + this.config.attemptTtlMs, status: "pending", previous });
    const url = new URL(this.config.authorizeUrl);
    const params = { client_id: previous?.secret.clientId ?? "dynamic_agent_client", ...(!previous ? { agent_name_hint: "Bastion" } : {}), ext_agent_host_id: this.config.hostId, response_type: "code", redirect_uri: this.config.redirectUri, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", resource: this.config.resource, state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { attemptId: id, authorizationUrl: url.href };
  }
  status(owner: string, id: string) {
    const attempt = this.own(owner, id);
    return { status: attempt.status, models: attempt.models?.map(({ id, name }) => ({ id, name })), error: attempt.error, connection: attempt.connection };
  }
  private async exchange(body: Record<string, string>) {
    const response = await this.request(this.config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(this.connections.controller.timeoutMs), redirect: "error" });
    if (!response.ok) throw new SignInFailure(`Token exchange was rejected (HTTP ${response.status}). Start a new sign-in; authorization codes cannot be reused.`);
    return TokenResponse.parse(await response.json());
  }
  private async identity(token: string, clientId: string, nonce?: string) {
    const { payload } = await jwtVerify(token, this.keys, { issuer: this.config.issuer, audience: clientId, requiredClaims: ["sub", "exp", "iat"], algorithms: ["RS256", "ES256"] });
    if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw new Error("Identity did not match sign-in");
    return payload.sub;
  }
  async callback(query: { state: string; code?: string; client_id?: string; error?: string }) {
    this.prune();
    const attempt = [...this.attempts.values()].find(value => value.state === query.state && value.status === "pending");
    if (!attempt) throw new HttpError("VALIDATION", "Sign-in expired or already used. Start again in Bastion.");
    attempt.status = "exchanging"; // Consume state before any network operation.
    let stage = "authorization callback";
    try {
      if (query.error || !query.code) throw new SignInFailure("Authorization was cancelled or did not return a code. Start sign-in again.");
      const clientId = query.client_id ?? attempt.previous?.secret.clientId;
      if (!clientId || clientId === "dynamic_agent_client" || (attempt.previous && clientId !== attempt.previous.secret.clientId)) throw new SignInFailure("The authorization callback did not return the expected issued client ID. Start sign-in again.");
      stage = "token exchange";
      const result = await this.exchange({ grant_type: "authorization_code", client_id: clientId, code: query.code, code_verifier: attempt.verifier, redirect_uri: this.config.redirectUri, resource: this.config.resource });
      if (!result.id_token || !result.refresh_token) throw new SignInFailure("The token response is missing an identity or refresh token. The account session could not be established.");
      stage = "identity verification";
      const subject = await this.identity(result.id_token, clientId, attempt.nonce);
      if (attempt.previous && subject !== attempt.previous.secret.subject) throw new SignInFailure("The signed-in account differs from the connection being renewed.");
      const scopes = result.scope?.split(/\s+/) ?? [];
      if (!scopes.includes("chatgpt.tokens.use.direct")) throw new SignInFailure("OpenAI did not grant chatgpt.tokens.use.direct. This authorization does not permit ChatGPT plan inference.");
      stage = "account model discovery";
      const response = await this.request(`${this.config.resource.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${result.access_token}` }, signal: AbortSignal.timeout(this.connections.controller.timeoutMs), redirect: "error" });
      if (!response.ok) throw new SignInFailure(`Account model discovery was rejected (HTTP ${response.status}). Authorization completed, but Bastion could not retrieve available models.`);
      const catalog = z.object({ models: z.array(z.object({ slug: z.string(), display_name: z.string(), visibility: z.string() })) }).parse(await response.json());
      const installed = piModelCatalog().filter(model => model.provider === "openai" && model.api === "openai-responses");
      attempt.models = catalog.models.filter(model => model.visibility === "list" && (installed.some(item => item.id === model.slug) || this.accountModelConfig) && (!attempt.previous || model.slug === attempt.previous.model)).map(model => ({ id: model.slug, name: model.display_name, ...(!installed.some(item => item.id === model.slug) ? { metadata: this.accountModelConfig } : {}) }));
      if (!attempt.models.length) throw new SignInFailure(attempt.previous ? "The connection’s selected model is no longer available from this account. Create a new connection to choose another model." : "No usable account models were returned. If the account has visible models absent from Pi, configure CHATGPT_MODEL_CONFIG with explicit Responses runtime limits.");
      if (attempt.expires <= Date.now()) throw new SignInFailure("Sign-in expired during authorization. Start again.");
      attempt.secret = { kind: "chatgpt", accessToken: result.access_token, refreshToken: result.refresh_token, idToken: result.id_token, expiresAt: Date.now() + result.expires_in * 1000, clientId, subject, scopes };
      attempt.verifier = ""; attempt.status = "choose-model";
    } catch (error) {
      attempt.models = undefined;
      attempt.secret = undefined; attempt.previous = undefined; attempt.verifier = ""; attempt.status = "failed";
      // Only application-authored messages cross the boundary. Provider bodies, JWT
      // claims, request URLs, and exception messages can contain credentials.
      const reason = error instanceof SignInFailure ? error.message
        : error instanceof z.ZodError ? `Unexpected response format during ${stage}. Bastion's integration needs checking.`
        : `Failed during ${stage}. ${stage === "identity verification" ? "The signed identity could not be verified; check issuer, audience, nonce, and signing-key connectivity." : "Check controller connectivity and timeout settings, then start sign-in again."}`;
      attempt.error = `ChatGPT sign-in could not be completed. ${reason}`;
      throw new HttpError("UNAVAILABLE", attempt.error);
    }
  }
  async complete(owner: string, id: string, model: string) {
    const attempt = this.own(owner, id);
    if (attempt.status !== "choose-model" || !attempt.secret || !attempt.models?.some(item => item.id === model)) throw new HttpError("CONFLICT", "Complete sign-in and choose an available account model");
    attempt.status = "exchanging";
    try {
      if (attempt.previous) {
        await this.connections.own(owner, attempt.previous.id);
        const [row] = await this.connections.db.update(schema.providerConnections).set({ credential: this.connections.seal(attempt.secret, owner, attempt.previous.id), metadata: attempt.models.find(item => item.id === model)?.metadata ?? null }).where(and(eq(schema.providerConnections.id, attempt.previous.id), eq(schema.providerConnections.disabled, false))).returning();
        if (!row) throw new Error("Connection disabled");
        attempt.connection = this.connections.public(row);
      } else {
        attempt.connection = await this.connections.save(owner, attempt.label, { provider: "openai", model, baseUrl: this.config.resource, customModel: attempt.models.find(item => item.id === model)?.metadata }, attempt.secret);
      }
      attempt.secret = undefined; attempt.previous = undefined; attempt.models = undefined; attempt.status = "connected";
      return attempt.connection;
    } catch { attempt.status = "failed"; attempt.secret = undefined; throw new HttpError("UNAVAILABLE", "Could not save the connection. Start sign-in again."); }
  }
  private async refresh(secret: ChatSecret): Promise<ChatSecret> {
    const result = await this.exchange({ grant_type: "refresh_token", client_id: secret.clientId, refresh_token: secret.refreshToken, resource: this.config.resource });
    if (result.id_token && await this.identity(result.id_token, secret.clientId) !== secret.subject) throw new Error("Account changed");
    const scopes = result.scope?.split(/\s+/) ?? secret.scopes;
    if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("Permission removed");
    return { ...secret, accessToken: result.access_token, refreshToken: result.refresh_token ?? secret.refreshToken, expiresAt: Date.now() + result.expires_in * 1000, idToken: result.id_token ?? secret.idToken, scopes };
  }
}
