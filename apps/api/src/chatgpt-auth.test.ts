import { randomBytes, randomUUID, createHash } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { createTestDb } from "@bastion/db/testing";
import { schema } from "@bastion/db";
import { piModelCatalog, piModelRegistry, type CustomModel } from "@bastion/runtime-pi";
import { ChatGPTAuth, ChatGPTConfig } from "./chatgpt-auth";
import { ProviderConnections } from "./provider-connections";

async function harness(accountModelConfig?: CustomModel) {
  const db = await createTestDb(), { privateKey, publicKey } = await generateKeyPair("ES256");
  const entry = piModelCatalog().find(model => model.provider === "openai" && model.api === "openai-responses")!;
  const connections = new ProviderConnections(db.db, { provider: entry.provider, model: entry.id, baseUrl: entry.baseUrl, authMode: "api-key", apiKey: randomUUID(), agentDir: "/tmp", timeoutMs: 5000 }, randomBytes(32).toString("hex"));
  const owner = randomUUID(), clientId = randomUUID(), subject = randomUUID();
  const config = { issuer: "https://auth.test.invalid", authorizeUrl: "https://auth.test.invalid/authorize", tokenUrl: "https://auth.test.invalid/token", jwksUrl: "https://auth.test.invalid/jwks", resource: "https://api.test.invalid/v1", redirectUri: "http://127.0.0.1:3001/auth/chatgpt/callback", hostId: `urn:uuid:${randomUUID()}`, attemptTtlMs: 60_000, maxPending: 5 };
  let nonce = "", grant = true, expiresIn = 60;
  let audience: string = clientId;
  const accessToken = randomUUID(), refreshToken = randomUUID();
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === config.tokenUrl) {
      const form = new URLSearchParams(init!.body as URLSearchParams);
      if (form.get("grant_type") === "authorization_code") {
        expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(startUrl.searchParams.get("code_challenge"));
        expect(form.get("redirect_uri")).toBe(config.redirectUri);
        expect(form.get("client_id")).toBe(clientId);
      }
      const jwt = await new SignJWT({ nonce }).setProtectedHeader({ alg: "ES256" }).setSubject(subject).setIssuer(config.issuer).setAudience(audience).setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: expiresIn, id_token: jwt, scope: grant ? "openid chatgpt.tokens.use.direct offline_access" : "openid" });
    }
    expect(String(url)).toBe(`${config.resource}/models`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    return Response.json({ models: [{ slug: entry.id, display_name: entry.name, visibility: "list" }, { slug: randomUUID(), display_name: randomUUID(), visibility: "list" }] });
  });
  const auth = new ChatGPTAuth(config, connections, request, async () => publicKey, accountModelConfig);
  const start = await auth.start(owner, randomUUID()); const startUrl = new URL(start.authorizationUrl); nonce = startUrl.searchParams.get("nonce")!;
  return { ...db, connections, auth, owner, clientId, subject, config, start, startUrl, request, entry, accessToken, refreshToken,
    callback: () => ({ state: startUrl.searchParams.get("state")!, client_id: clientId, code: randomUUID() }),
    setNonce: (value: string) => { nonce = value; }, setGrant: (value: boolean) => { grant = value; }, setAudience: (value: string) => { audience = value; }, setExpiry: (value: number) => { expiresIn = value; },
    async cleanup() { auth.close(); await db.close(); } };
}
it("validates a signed account session, enforces owner/state, returns account models only, and persists encrypted credentials", async () => {
  const t = await harness();
  try {
    expect(t.startUrl.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(t.startUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(t.startUrl.searchParams.get("ext_agent_host_id")).toBe(t.config.hostId);
    const againOnHost = await t.auth.start(t.owner, randomUUID());
    expect(new URL(againOnHost.authorizationUrl).searchParams.get("ext_agent_host_id")).toBe(t.config.hostId);
    expect(() => t.auth.status(randomUUID(), t.start.attemptId)).toThrow("not found");
    await expect(t.auth.callback({ ...t.callback(), state: randomUUID() })).rejects.toThrow("expired");
    expect(t.request).not.toHaveBeenCalled();
    await t.auth.callback(t.callback());
    const status = t.auth.status(t.owner, t.start.attemptId);
    expect(status.status).toBe("choose-model"); expect(status.models).toEqual([{ id: t.entry.id, name: t.entry.name }]);
    expect(JSON.stringify(status)).not.toContain(t.accessToken); expect(JSON.stringify(status)).not.toContain(t.refreshToken);
    await expect(t.auth.callback(t.callback())).rejects.toThrow("already used");
    await expect(t.auth.complete(randomUUID(), t.start.attemptId, t.entry.id)).rejects.toThrow("not found");
    await expect(t.auth.complete(t.owner, t.start.attemptId, randomUUID())).rejects.toThrow("available account model");
    const saved = await t.auth.complete(t.owner, t.start.attemptId, t.entry.id);
    expect(saved.authMode).toBe("chatgpt");
    const config = await t.connections.config(t.owner, saved.id);
    expect(config).toMatchObject({ provider: "openai", model: t.entry.id, baseUrl: t.config.resource, authMode: "api-key", apiKey: t.accessToken });
    const [row] = await t.db.select().from(schema.providerConnections);
    expect(row!.credential).not.toContain(t.accessToken);
    const again = await t.auth.start(t.owner, randomUUID(), saved.id);
    expect(new URL(again.authorizationUrl).searchParams.get("client_id")).toBe(t.clientId);
    expect(again.authorizationUrl).not.toContain(t.refreshToken);
  } finally { await t.cleanup(); }
});
it.each(["nonce", "audience", "scope", "denied"])("fails closed on invalid %s without exposing or persisting credentials", async kind => {
  const t = await harness();
  try {
    if (kind === "nonce") t.setNonce(randomUUID());
    if (kind === "audience") t.setAudience(randomUUID());
    if (kind === "scope") t.setGrant(false);
    await expect(t.auth.callback({ ...t.callback(), ...(kind === "denied" ? { error: "access_denied" } : {}) })).rejects.toThrow("could not be completed");
    expect((await t.connections.list(t.owner))).toEqual([]);
    expect(t.auth.status(t.owner, t.start.attemptId).status).toBe("failed");
    expect(JSON.stringify(t.auth.status(t.owner, t.start.attemptId))).not.toContain(t.accessToken);
    expect(t.request.mock.calls.length).toBe(kind === "denied" ? 0 : 1);
  } finally { await t.cleanup(); }
});
it("refreshes an expired account once for simultaneous agents and keeps disabled credentials erased", async () => {
  const t = await harness();
  try {
    await t.auth.callback(t.callback());
    const saved = await t.auth.complete(t.owner, t.start.attemptId, t.entry.id);
    const row = await t.connections.own(t.owner, saved.id), secret = t.connections.open(row);
    if (secret.kind !== "chatgpt") throw new Error("Expected OAuth");
    await t.db.update(schema.providerConnections).set({ credential: t.connections.seal({ ...secret, expiresAt: Date.now() - 1 }, t.owner, row.id) });
    const before = t.request.mock.calls.length;
    const result = await Promise.all([t.connections.config(t.owner, row.id), t.connections.config(t.owner, row.id)]);
    expect(result[0]).toEqual(result[1]); expect(t.request.mock.calls.length - before).toBe(1);
    await t.connections.disable(t.owner, row.id);
    await expect(t.connections.config(t.owner, row.id)).rejects.toThrow("disconnected");
    expect((await t.db.select().from(schema.providerConnections))[0]!.credential).toBe("");
  } finally { await t.cleanup(); }
});
it("requires an explicit loopback callback matching the configured API port", async () => {
  const t = await harness();
  try {
    expect(() => ChatGPTAuth.fromEnv({ API_PORT: "3001", CHATGPT_OAUTH_CONFIG: JSON.stringify({ ...t.config, redirectUri: "http://localhost:3001/auth/chatgpt/callback" }) }, t.connections)).toThrow("127.0.0.1");
    expect(() => ChatGPTAuth.fromEnv({ API_PORT: "3002", CHATGPT_OAUTH_CONFIG: JSON.stringify(t.config) }, t.connections)).toThrow("API port");
  } finally { await t.cleanup(); }
});

it("rejects bare and malformed UUID host identifiers before authorization", () => {
  const hostId = ChatGPTConfig.shape.hostId;
  const uuid = randomUUID();
  expect(hostId.parse(`urn:uuid:${uuid}`)).toBe(`urn:uuid:${uuid}`);
  for (const value of [uuid, "urn:uuid:", `urn:uuid:${uuid.replaceAll("-", "")}`, "user@example.invalid"]) {
    expect(hostId.safeParse(value).success).toBe(false);
  }
});

it.each(["token-http", "token-format", "network", "models-http", "models-format", "models-empty"])("reports safe diagnostics for %s", async kind => {
  const t = await harness();
  try {
    const original = t.request.getMockImplementation()!;
    t.request.mockImplementation(async (url, init) => {
      const token = String(url) === t.config.tokenUrl;
      if (token && kind === "token-http") return Response.json({ error_description: t.accessToken }, { status: 400 });
      if (token && kind === "token-format") return Response.json({ access_token: t.accessToken });
      if (token && kind === "network") throw new Error(t.accessToken);
      if (!token && kind === "models-http") return Response.json({ error: t.accessToken }, { status: 403 });
      if (!token && kind === "models-format") return Response.json({ unexpected: t.accessToken });
      if (!token && kind === "models-empty") return Response.json({ models: [] });
      return original(url, init);
    });
    const expected = { "token-http": "HTTP 400", "token-format": "response format during token exchange", network: "Failed during token exchange", "models-http": "HTTP 403", "models-format": "response format during account model discovery", "models-empty": "No usable account models" }[kind];
    await expect(t.auth.callback(t.callback())).rejects.toThrow(expected);
    const status = t.auth.status(t.owner, t.start.attemptId);
    expect(status.status).toBe("failed");
    expect(status.models).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(t.accessToken);
    expect(JSON.stringify(status)).not.toContain(t.refreshToken);
    expect(await t.connections.list(t.owner)).toEqual([]);
    await expect(t.auth.callback(t.callback())).rejects.toThrow("already used");
  } finally { await t.cleanup(); }
});


it("registers a newly discovered account model for Responses without a bundled catalog entry", async () => {
  const profile: CustomModel = { api: "openai-responses", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const t = await harness(profile);
  try {
    await t.auth.callback(t.callback());
    const models = t.auth.status(t.owner, t.start.attemptId).models!;
    const discovered = models.find(model => model.id !== t.entry.id)!;
    expect(discovered).toBeDefined();
    expect(discovered).not.toHaveProperty("metadata");
    await expect(t.auth.complete(t.owner, t.start.attemptId, randomUUID())).rejects.toThrow("available account model");
    const saved = await t.auth.complete(t.owner, t.start.attemptId, discovered.id);
    const config = await t.connections.config(t.owner, saved.id);
    const { model } = piModelRegistry(config);
    expect(model.id).toBe(discovered.id);
    expect(model.api).toBe("openai-responses");
    expect(model.baseUrl).toBe(t.config.resource);
    expect(model.contextWindow).toBe(profile.contextWindow);
    expect(model.maxTokens).toBe(profile.maxTokens);
    expect(config.authMode === "api-key" && config.apiKey).toBe(t.accessToken);
  } finally { await t.cleanup(); }
});
