import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@bastion/db";
import { z } from "zod";
import { HttpError } from "./errors";

const https = z.string().url().refine(value => { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; });
export const GitHubOAuthConfig = z.object({
  clientId: z.string().min(1), authorizeUrl: https, tokenUrl: https, userUrl: https,
  redirectUri: z.string().url(), scope: z.enum(["public_repo", "repo"]),
  timeoutMs: z.number().int().positive(), attemptTtlMs: z.number().int().positive(), maxPending: z.number().int().positive(),
}).strict();
type Config = z.infer<typeof GitHubOAuthConfig>;
type Attempt = { owner: string; state: string; verifier: string; expires: number; status: "pending" | "exchanging" | "confirm" | "connected" | "failed"; token?: string; login?: string; accountId?: string; scopes?: string; error?: string };

/** OAuth credentials stay controller-side, encrypted and bound to their Bastion owner. */
export class GitHubAuth {
  private attempts = new Map<string, Attempt>();
  private key: Buffer;
  private ownerLocks = new Map<string, Promise<unknown>>();
  private async serialized<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const previous = this.ownerLocks.get(owner) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    this.ownerLocks.set(owner, pending);
    try { return await pending; } finally { if (this.ownerLocks.get(owner) === pending) this.ownerLocks.delete(owner); }
  }
  readonly config: Config;
  constructor(private db: Db, config: Config, private clientSecret: string, key: string, private request: typeof fetch = fetch) {
    this.config = GitHubOAuthConfig.parse(config);
    const callback = new URL(config.redirectUri);
    if ((callback.protocol !== "https:" && !(callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))) || callback.pathname !== "/auth/github/callback" || callback.username || callback.password || callback.search || callback.hash) throw new Error("Invalid GitHub callback URL");
    if (!clientSecret || !/^[a-f\d]{64}$/i.test(key)) throw new Error("GitHub OAuth requires a client secret and a 32-byte credential key encoded as hex");
    this.key = Buffer.from(key, "hex");
  }
  static fromEnv(db: Db, env: NodeJS.ProcessEnv) {
    if (!env.GITHUB_OAUTH_CONFIG) return undefined;
    return new GitHubAuth(db, GitHubOAuthConfig.parse(JSON.parse(env.GITHUB_OAUTH_CONFIG)), env.GITHUB_OAUTH_CLIENT_SECRET ?? "", env.PROVIDER_CREDENTIAL_KEY ?? "");
  }
  close() { this.attempts.clear(); }
  private prune() { for (const [id, a] of this.attempts) if (a.expires <= Date.now()) this.attempts.delete(id); }
  private own(owner: string, id: string) {
    this.prune(); const a = this.attempts.get(id);
    if (!a || a.owner !== owner) throw new HttpError("NOT_FOUND", "GitHub sign-in expired or not found. Start again.");
    return a;
  }
  start(owner: string) {
    this.prune();
    if (this.attempts.size >= this.config.maxPending) throw new HttpError("RATE_LIMITED", "Too many pending sign-ins");
    for (const [id, a] of this.attempts) if (a.owner === owner) this.attempts.delete(id);
    const id = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    this.attempts.set(id, { owner, state, verifier, expires: Date.now() + this.config.attemptTtlMs, status: "pending" });
    const url = new URL(this.config.authorizeUrl);
    for (const [key, value] of Object.entries({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, scope: this.config.scope, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) url.searchParams.set(key, value);
    return { attemptId: id, authorizationUrl: url.href };
  }
  status(owner: string, id: string) {
    const a = this.own(owner, id);
    return { status: a.status, login: a.login, error: a.error };
  }
  async callback(query: { state: string; code?: string; error?: string }) {
    this.prune();
    const entry = [...this.attempts.entries()].find(([, a]) => a.state === query.state && a.status === "pending");
    if (!entry) throw new HttpError("VALIDATION", "GitHub sign-in expired or already used");
    const [id, a] = entry;
    a.status = "exchanging";
    try {
      if (query.error || !query.code) throw new Error();
      const response = await this.request(this.config.tokenUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs), headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.clientSecret, code: query.code, redirect_uri: this.config.redirectUri, code_verifier: a.verifier }) });
      if (!response.ok) throw new Error();
      const result = z.object({ access_token: z.string().min(1), token_type: z.string(), scope: z.string() }).parse(await response.json());
      const scopes = result.scope.split(/[ ,]+/);
      if (result.token_type.toLowerCase() !== "bearer" || !(scopes.includes(this.config.scope) || (this.config.scope === "public_repo" && scopes.includes("repo")))) throw new Error();
      const user = await this.request(this.config.userUrl, { redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs), headers: { authorization: `Bearer ${result.access_token}`, accept: "application/vnd.github+json" } });
      if (!user.ok) throw new Error();
      const identity = z.object({ id: z.number().int().positive(), login: z.string().min(1) }).parse(await user.json());
      if (this.attempts.get(id) !== a || a.expires <= Date.now()) throw new Error();
      Object.assign(a, { status: "confirm", token: result.access_token, login: identity.login, accountId: String(identity.id), scopes: result.scope });
    } catch {
      a.status = "failed"; a.token = undefined; a.error = "GitHub authorization failed or was cancelled. Start a new sign-in.";
      throw new HttpError("VALIDATION", a.error);
    }
  }
  complete(owner: string, id: string) { return this.serialized(owner, () => this.save(owner, id)); }
  private async save(owner: string, id: string) {
    const a = this.own(owner, id);
    if (a.status !== "confirm" || !a.token || !a.login || !a.accountId || !a.scopes) throw new HttpError("CONFLICT", "Finish GitHub authorization first");
    // Owner confirmation binds the displayed GitHub identity to the authenticated Bastion session.
    a.status = "exchanging";
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(["github", owner, a.accountId])));
    const encrypted = Buffer.concat([cipher.update(a.token, "utf8"), cipher.final()]);
    const values = { ownerId: owner, accountId: a.accountId, login: a.login, scopes: a.scopes, credential: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64"), connectedAt: new Date().toISOString() };
    try {
      await this.db.insert(schema.githubConnections).values(values).onConflictDoUpdate({ target: schema.githubConnections.ownerId, set: values });
      a.token = undefined; a.status = "connected";
      return this.connection(owner);
    } catch { a.token = undefined; a.status = "failed"; throw new HttpError("UNAVAILABLE", "Could not save GitHub connection. Start sign-in again."); }
  }
  async connection(owner: string) {
    const [row] = await this.db.select({ login: schema.githubConnections.login, scopes: schema.githubConnections.scopes, connectedAt: schema.githubConnections.connectedAt }).from(schema.githubConnections).where(eq(schema.githubConnections.ownerId, owner));
    return row ?? null;
  }
  async accessToken(owner: string) {
    const [row] = await this.db.select().from(schema.githubConnections).where(eq(schema.githubConnections.ownerId, owner));
    if (!row) throw new HttpError("UNAVAILABLE", "Connect GitHub first");
    try {
      const bytes = Buffer.from(row.credential, "base64"), decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(JSON.stringify(["github", owner, row.accountId]))); decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    } catch { throw new HttpError("UNAVAILABLE", "Reconnect GitHub: credentials could not be opened"); }
  }
  async disconnect(owner: string) {
    for (const [id, a] of this.attempts) if (a.owner === owner) this.attempts.delete(id);
    await this.serialized(owner, async () => { await this.db.delete(schema.githubConnections).where(eq(schema.githubConnections.ownerId, owner)); });
  }
}
