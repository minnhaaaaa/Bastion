import { afterEach, expect, it } from "vitest";
import { win32, posix, join, relative, isAbsolute } from "node:path";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { io, type Socket } from "socket.io-client";
import { newId } from "@bastion/contracts";
import { schema } from "@bastion/db";
import { escapesRoot } from "./repository-access";
import { RuntimeSecurity, assertModelBoundary, parseSecurityConfig } from "./security-config";
import { boundedFile, boundedResponse } from "./runtime/bounded-input";
import { createTestApp, testWorkflowDefinition } from "./testing";
import { testRuntimeSecurity } from "../../../tests/security-settings";

const cleanup: (() => Promise<unknown>)[] = [];
async function removeTestDirectory(directory: string) {
  const suffix = relative(await realpath(tmpdir()), await realpath(directory));
  if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) throw new Error("Unsafe test cleanup");
  await rm(directory, { recursive: true, force: true });
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("rejects sibling traversal on both Windows and POSIX", () => {
  expect(escapesRoot(win32.relative("C:\\workspace", "C:\\outside\\repo"))).toBe(true);
  expect(escapesRoot(posix.relative("/workspace", "/outside/repo"))).toBe(true);
  expect(escapesRoot(win32.relative("C:\\workspace", "C:\\workspace\\repo"))).toBe(false);
});

it("requires explicit security settings and blocks unapproved model destinations and classifications", () => {
  const origin = `https://${crypto.randomUUID()}.invalid`;
  const settings = parseSecurityConfig(RuntimeSecurity, testRuntimeSecurity([origin]), "RUNTIME_SECURITY_JSON");
  expect(() => parseSecurityConfig(RuntimeSecurity, undefined, "RUNTIME_SECURITY_JSON")).toThrow("Missing");
  expect(() => parseSecurityConfig(RuntimeSecurity, "{}", "RUNTIME_SECURITY_JSON")).toThrow("Invalid");
  expect(() => assertModelBoundary(settings, `${origin}/api`, ["INTERNAL"])).not.toThrow();
  expect(() => assertModelBoundary(settings, `https://${crypto.randomUUID()}.invalid`, ["PUBLIC"])).toThrow("destination");
  expect(() => assertModelBoundary(settings, origin, ["SYNTHETIC_SECRET"])).toThrow("classification");
  expect(() => assertModelBoundary(settings, origin.replace("https://", "https://u:p@"), [])).toThrow("destination");
});

it("bounds file reads before consuming oversized contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bastion-bounded-"));
  cleanup.push(() => removeTestDirectory(directory));
  const path = join(directory, crypto.randomUUID());
  const value = crypto.randomUUID();
  await writeFile(path, value);
  await expect(boundedFile(path, Buffer.byteLength(value))).resolves.toEqual(Buffer.from(value));
  await expect(boundedFile(path, 1)).rejects.toThrow("size limit");
});

it("stops and cancels an oversized HTTP stream before draining it", async () => {
  let produced = 0, cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { produced++; controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  }));
  await expect(boundedResponse(response, 4)).rejects.toThrow("size limit");
  expect(cancelled).toBe(true);
  expect(produced).toBeLessThanOrEqual(2);
});

async function workspace(options: Parameters<typeof createTestApp>[0] = {}) {
  const app = await createTestApp({ launcher: { launch: async () => {} }, ...options });
  cleanup.push(app.close);
  const headers = app.auth(app.tokenA);
  const post = (url: string, payload: object) => app.app.inject({ method: "POST", url, headers, payload: { commandId: newId("command"), ...payload } });
  const project = (await post("/api/projects", { name: crypto.randomUUID() })).json();
  const workflow = (await post("/api/workflows", { projectId: project.id, definition: testWorkflowDefinition() })).json();
  return { ...app, post, workflow };
}

it("rejects production baseline runs before persisting or executing them", async () => {
  const app = await workspace({ baselineEnabled: false });
  const result = await app.post("/api/runs", { workflowId: app.workflow.id, mode: "BASELINE" });
  expect(result.statusCode).toBe(403);
  expect(await app.db.select().from(schema.runs)).toHaveLength(0);
});

it("serializes concurrent run admission so the owner quota cannot be raced", async () => {
  const app = await workspace({ security: { maxActiveRunsPerOwner: 1 } });
  const results = await Promise.all(Array.from({ length: 3 }, () => app.post("/api/runs", { workflowId: app.workflow.id, mode: "PROTECTED" })));
  expect(results.map(result => result.statusCode).sort()).toEqual([201, 429, 429]);
  expect(await app.db.select().from(schema.runs)).toHaveLength(1);
});

it("limits workflow complexity before execution", async () => {
  const app = await workspace({ security: { maxWorkflowTasks: 1 } });
  expect((await app.post("/api/runs", { workflowId: app.workflow.id, mode: "PROTECTED" })).statusCode).toBe(400);
  expect(await app.db.select().from(schema.runs)).toHaveLength(0);
});

it("applies global rate limits outside Arena routes", async () => {
  const app = await createTestApp({ security: { requestsPerMinute: 1 } }); cleanup.push(app.close);
  expect((await app.app.inject({ url: "/health" })).statusCode).toBe(200);
  expect((await app.app.inject({ url: "/health" })).statusCode).toBe(429);
});

it("withholds non-public source and inherited artifact previews regardless of secret format", async () => {
  const app = await workspace();
  const runId = (await app.post("/api/runs", { workflowId: app.workflow.id, mode: "PROTECTED" })).json().runId;
  const source = await app.broker.ingestSource({ runId, traceId: newId("trace"), name: crypto.randomUUID(), content: "a short unrecognizable sensitive value", trust: "UNTRUSTED", classification: "SYNTHETIC_SECRET" });
  expect(source.preview).toBe("");
  expect(JSON.stringify(await app.journal.read(runId))).not.toContain("unrecognizable sensitive");
  // Old persisted events may contain previews emitted before classification enforcement.
  const legacy = "sensitive legacy value";
  await app.journal.append(runId, [{ runId, traceId: newId("trace"), type: "source.modified", payload: {
    sourceVersionId: newId("source"), previousVersionId: source.id, name: source.name,
    version: source.version + 1, contentHash: source.contentHash, blobRef: source.blobRef,
    trust: source.trust, classification: source.classification, preview: legacy,
  } }]);
  expect(JSON.stringify(await app.journal.read(runId))).toContain(legacy);
  expect((await app.app.inject({ url: `/api/runs/${runId}`, headers: app.auth(app.tokenA) })).body).not.toContain(legacy);
  expect((await app.app.inject({ url: `/api/runs/${runId}/events`, headers: app.auth(app.tokenA) })).body).not.toContain(legacy);
});

async function connected(url: string, token: string): Promise<Socket> {
  const socket = io(url, { transports: ["websocket"], auth: { token }, reconnection: false });
  cleanup.push(async () => { socket.disconnect(); });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return socket;
}

it("revokes a run-only socket on room expiry and rejects tokens before the sweep", async () => {
  const app = await workspace();
  const runId = (await app.post("/api/runs", { workflowId: app.workflow.id, mode: "PROTECTED" })).json().runId;
  const room = (await app.post("/api/arena/rooms", { workflowId: app.workflow.id })).json();
  await app.db.update(schema.arenaRooms).set({ runId }).where(eq(schema.arenaRooms.id, room.roomId));
  const url = await app.app.listen({ port: 0, host: "127.0.0.1" });
  const socket = await connected(url, room.hostToken);
  expect(await socket.timeout(2000).emitWithAck("run.subscribe", { runId })).toEqual({ ok: true });
  await app.db.update(schema.arenaRooms).set({ expiresAt: new Date(Date.now() - 1).toISOString() }).where(eq(schema.arenaRooms.id, room.roomId));
  expect((await app.app.inject({ url: `/api/runs/${runId}`, headers: app.auth(room.hostToken) })).statusCode).toBe(401);
  const disconnected = new Promise<void>(resolve => socket.once("disconnect", () => resolve()));
  await app.arena.sweepExpired();
  await disconnected;
  expect(socket.connected).toBe(false);
});

it("limits simultaneous sockets per authenticated actor", async () => {
  const app = await workspace({ security: { maxSocketsPerActor: 1 } });
  const url = await app.app.listen({ port: 0, host: "127.0.0.1" });
  await connected(url, app.tokenA);
  await expect(connected(url, app.tokenA)).rejects.toThrow("quota");
});
