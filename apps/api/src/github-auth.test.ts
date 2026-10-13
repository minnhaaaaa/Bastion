import { randomBytes, createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@bastion/db";
import { createTestDb } from "@bastion/db/testing";
import { GitHubAuth } from "./github-auth";
import { createTestApp } from "./testing";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const t = await createTestDb(); cleanup.push(t.close);
  const token = randomBytes(32).toString("hex"), clientSecret = randomBytes(32).toString("hex"), owner = crypto.randomUUID();
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: token, token_type: "bearer", scope: "public_repo" })).mockResolvedValueOnce(Response.json({ id: 123, login: "test-account" }));
  const config = { clientId: crypto.randomUUID(), authorizeUrl: "https://github.example.invalid/login/oauth/authorize", tokenUrl: "https://github.example.invalid/login/oauth/access_token", userUrl: "https://api.example.invalid/user", redirectUri: "http://127.0.0.1:3001/auth/github/callback", scope: "public_repo" as const, timeoutMs: 1000, attemptTtlMs: 60000, maxPending: 5 };
  const auth = new GitHubAuth(t.db, config, clientSecret, randomBytes(32).toString("hex"), request);
  cleanup.push(async () => auth.close());
  const start = auth.start(owner), url = new URL(start.authorizationUrl), state = url.searchParams.get("state")!;
  return { ...t, auth, config, token, clientSecret, owner, request, start, url, state };
}

it("uses PKCE, confirms the owner account, encrypts credentials, and exposes only public metadata", async () => {
  const t = await setup();
  expect(t.url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(t.start.authorizationUrl).not.toContain(t.clientSecret);
  await t.auth.callback({ state: t.state, code: crypto.randomUUID() });
  const exchange = t.request.mock.calls[0]![1]!;
  const body = exchange.body as URLSearchParams;
  expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(t.url.searchParams.get("code_challenge"));
  expect(exchange.redirect).toBe("error");
  expect(t.auth.status(t.owner, t.start.attemptId)).toMatchObject({ status: "confirm", login: "test-account" });
  expect(await t.auth.connection(t.owner)).toBeNull();
  await expect(t.auth.complete("another-owner", t.start.attemptId)).rejects.toThrow("not found");
  const publicResult = await t.auth.complete(t.owner, t.start.attemptId);
  expect(publicResult?.login).toBe("test-account");
  expect(JSON.stringify(publicResult)).not.toContain(t.token);
  const [row] = await t.db.select().from(schema.githubConnections);
  expect(row!.credential).not.toContain(t.token);
  expect(await t.auth.accessToken(t.owner)).toBe(t.token);
  expect(await t.auth.connection("another-owner")).toBeNull();
  await expect(t.auth.callback({ state: t.state, code: "replay" })).rejects.toThrow("already used");
  await t.auth.disconnect(t.owner);
  await expect(t.auth.accessToken(t.owner)).rejects.toThrow("Connect GitHub first");
});

it("rejects unknown states, owner mismatch, missing scopes and token errors without leaking secrets", async () => {
  const t = await setup();
  expect(() => t.auth.status("another-owner", t.start.attemptId)).toThrow("not found");
  await expect(t.auth.callback({ state: crypto.randomUUID(), code: "code" })).rejects.toThrow("expired");
  expect(t.request).not.toHaveBeenCalled();
  t.request.mockReset().mockResolvedValueOnce(Response.json({ access_token: t.token, token_type: "bearer", scope: "read:user", error_description: t.clientSecret }));
  await expect(t.auth.callback({ state: t.state, code: "code" })).rejects.toThrow("authorization failed");
  expect(JSON.stringify(t.auth.status(t.owner, t.start.attemptId))).not.toContain(t.token);
  expect(JSON.stringify(t.auth.status(t.owner, t.start.attemptId))).not.toContain(t.clientSecret);
  expect(await t.auth.connection(t.owner)).toBeNull();
});

it("expires attempts and invalidates outstanding authorization on disconnect", async () => {
  const t = await setup();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + t.config.attemptTtlMs + 1);
  await expect(t.auth.callback({ state: t.state, code: "code" })).rejects.toThrow("expired");
  vi.restoreAllMocks();
  const fresh = t.auth.start(t.owner);
  await t.auth.disconnect(t.owner);
  await expect(t.auth.callback({ state: new URL(fresh.authorizationUrl).searchParams.get("state")!, code: "code" })).rejects.toThrow("expired");
});

it("refuses credential swapping between owners", async () => {
  const t = await setup();
  await t.auth.callback({ state: t.state, code: "code" }); await t.auth.complete(t.owner, t.start.attemptId);
  const [row] = await t.db.select().from(schema.githubConnections);
  await t.db.insert(schema.githubConnections).values({ ...row!, ownerId: "other" });
  await expect(t.auth.accessToken("other")).rejects.toThrow("credentials could not be opened");
  await t.db.update(schema.githubConnections).set({ accountId: "changed" }).where(eq(schema.githubConnections.ownerId, t.owner));
  await expect(t.auth.accessToken(t.owner)).rejects.toThrow("credentials could not be opened");
});

it("authenticates routes, isolates sign-in attempts, and requires owner confirmation after callback", async () => {
  const t = await setup();
  const a = await createTestApp({ githubConfig: { config: t.config, secret: t.clientSecret, key: randomBytes(32).toString("hex"), request: t.request } }); cleanup.push(a.close);
  expect((await a.app.inject({ method: "POST", url: "/api/github/start", payload: {} })).statusCode).toBe(401);
  const start = (await a.app.inject({ method: "POST", url: "/api/github/start", payload: {}, headers: a.auth(a.tokenA) })).json();
  const url = `/api/github/attempts/${start.attemptId}`;
  expect((await a.app.inject({ url, headers: a.auth(a.tokenB) })).statusCode).toBe(404);
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  const callback = await a.app.inject({ url: `/auth/github/callback?state=${state}&code=generated-test-code` });
  expect(callback.statusCode).toBe(200);
  expect(callback.headers['cache-control']).toBe('no-store');
  expect(callback.body).not.toContain(t.token);
  const status = await a.app.inject({ url, headers: a.auth(a.tokenA) });
  expect(status.json().status).toBe('confirm'); expect(status.body).not.toContain(t.token);
  expect((await a.app.inject({ method: 'POST', url: url + '/complete', headers: a.auth(a.tokenB), payload: {} })).statusCode).toBe(404);
  expect((await a.app.inject({ method: 'POST', url: url + '/complete', headers: a.auth(a.tokenA), payload: {} })).statusCode).toBe(200);
  expect((await a.app.inject({ url: '/api/github/connection', headers: a.auth(a.tokenB) })).json().connection).toBeNull();
  expect((await a.app.inject({ method: 'POST', url: '/api/github/disconnect', headers: a.auth(a.tokenA), payload: {} })).statusCode).toBe(200);
  expect((await a.app.inject({ url: '/api/github/connection', headers: a.auth(a.tokenA) })).json().connection).toBeNull();
});
