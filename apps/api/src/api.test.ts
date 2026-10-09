import { afterEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { newId, type NewRunEvent, type RunEvent, type RunLauncher } from "@bastion/contracts";
import { loadEnv } from "./env";
import { createTestApp, testWorkflowDefinition } from "./testing";

type T = Awaited<ReturnType<typeof createTestApp>>;
let t: T | undefined;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await t?.close();
  t = undefined;
});

/** Test double for Member 2's launcher: records calls, ingests sources, plans the DAG. */
function recordingLauncher() {
  const calls: Parameters<RunLauncher["launch"]>[0][] = [];
  let app: T;
  const launcher: RunLauncher = {
    async launch(input) {
      calls.push(input);
      const { runId, workflow, traceId } = input;
      const ids: Record<string, string> = {};
      for (const s of workflow.definition.sources)
        ids[s.name] = (await app.broker.ingestSource({ runId, name: s.name, content: `content of ${s.name}`, trust: s.trust, classification: s.classification, traceId })).id;
      await app.journal.append(runId, [
        {
          runId,
          traceId,
          type: "run.planned",
          payload: {
            tasks: workflow.definition.tasks.map((x) => ({
              taskId: x.id,
              agentId: x.agentId,
              role: workflow.definition.agents.find((a) => a.id === x.agentId)!.role,
              title: x.title,
              declaredDeps: x.declaredDeps,
              sourceIds: x.sourceNames.map((n) => ids[n]!),
              retryPolicy: x.retryPolicy,
            })),
          },
        },
        { runId, traceId, type: "run.status_changed", payload: { from: "CREATED", to: "RUNNING" } },
      ] as NewRunEvent[]);
    },
  };
  return { launcher, calls, bind: (x: T) => (app = x) };
}

async function setupProjectAndWorkflow(x: T) {
  const p = await x.app.inject({ method: "POST", url: "/api/projects", headers: x.auth(x.tokenA), payload: { commandId: newId("command"), name: "proj" } });
  const projectId = p.json().id as string;
  const definition = testWorkflowDefinition();
  const w = await x.app.inject({ method: "POST", url: "/api/workflows", headers: x.auth(x.tokenA), payload: { commandId: newId("command"), projectId, definition } });
  return { projectId, workflow: w.json(), definition };
}

const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("config", () => {
  it("refuses to start without required environment", () => {
    expect(() => loadEnv({})).toThrow(/API_PORT/);
  });
});

describe("REST", () => {
  it("health reports live state and runtime availability", async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ ok: true, runtimeConnected: false });
  });

  it("requires auth and scopes projects to their owner", async () => {
    t = await createTestApp();
    expect((await t.app.inject({ method: "GET", url: "/api/projects" })).statusCode).toBe(401);
    const { projectId } = await setupProjectAndWorkflow(t);
    const other = await t.app.inject({ method: "GET", url: `/api/workflows?projectId=${projectId}`, headers: t.auth(t.tokenB) });
    expect(other.statusCode).toBe(403);
  });

  it("commands are idempotent by commandId", async () => {
    t = await createTestApp();
    const payload = { commandId: newId("command"), name: "same" };
    const a = await t.app.inject({ method: "POST", url: "/api/projects", headers: t.auth(t.tokenA), payload });
    const b = await t.app.inject({ method: "POST", url: "/api/projects", headers: t.auth(t.tokenA), payload });
    expect(a.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(b.headers["idempotent-replay"]).toBe("true");
    const c = await t.app.inject({ method: "POST", url: "/api/projects", headers: t.auth(t.tokenB), payload });
    expect(c.statusCode).toBe(409);
  });

  it("validates workflow definitions", async () => {
    t = await createTestApp();
    const p = await t.app.inject({ method: "POST", url: "/api/projects", headers: t.auth(t.tokenA), payload: { commandId: newId("command"), name: "p" } });
    const bad = testWorkflowDefinition();
    bad.tasks[0]!.declaredDeps = [bad.tasks[1]!.id]; // cycle
    const res = await t.app.inject({ method: "POST", url: "/api/workflows", headers: t.auth(t.tokenA), payload: { commandId: newId("command"), projectId: p.json().id, definition: bad } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("runs cannot start without the agent runtime (503, nothing fabricated)", async () => {
    t = await createTestApp();
    const { workflow } = await setupProjectAndWorkflow(t);
    const res = await t.app.inject({ method: "POST", url: "/api/runs", headers: t.auth(t.tokenA), payload: { commandId: newId("command"), workflowId: workflow.id, mode: "PROTECTED" } });
    expect(res.statusCode).toBe(503);
  });

  it("starts a run via the launcher and serves snapshot/events/graph/incidents", async () => {
    const rl = recordingLauncher();
    t = await createTestApp({ launcher: rl.launcher });
    rl.bind(t);
    const { workflow } = await setupProjectAndWorkflow(t);
    const res = await t.app.inject({ method: "POST", url: "/api/runs", headers: t.auth(t.tokenA), payload: { commandId: newId("command"), workflowId: workflow.id, mode: "PROTECTED" } });
    expect(res.statusCode).toBe(201);
    const { runId } = res.json();
    await waitFor(async () => (await t!.journal.snapshot(runId))?.run.status === "RUNNING");

    const snap = (await t.app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: t.auth(t.tokenA) })).json();
    expect(Object.keys(snap.tasks)).toHaveLength(2);
    expect(Object.values(snap.sources)).toHaveLength(2);
    const events = (await t.app.inject({ method: "GET", url: `/api/runs/${runId}/events?after=1`, headers: t.auth(t.tokenA) })).json();
    expect(events[0].seq).toBe(2);
    const graph = (await t.app.inject({ method: "GET", url: `/api/runs/${runId}/graph`, headers: t.auth(t.tokenA) })).json();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect((await t.app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: t.auth(t.tokenB) })).statusCode).toBe(404);
    const list = (await t.app.inject({ method: "GET", url: "/api/runs", headers: t.auth(t.tokenA) })).json();
    expect(list.map((r: { id: string }) => r.id)).toContain(runId);

    // Operator incident flow over HTTP
    const src = Object.values(snap.sources as Record<string, { id: string; name: string }>).find((s) => s.name === "doc")!;
    const inc = await t.app.inject({ method: "POST", url: `/api/runs/${runId}/incidents`, headers: t.auth(t.tokenA), payload: { commandId: newId("command"), sourceVersionId: src.id, severity: "HIGH", reason: "suspicious" } });
    expect(inc.statusCode).toBe(201);
    const q = await t.app.inject({ method: "POST", url: `/api/incidents/${inc.json().id}/quarantine`, headers: t.auth(t.tokenA), payload: { commandId: newId("command"), sourceVersionId: src.id } });
    expect(q.statusCode).toBe(200);
    expect(q.json().suggestedReplacementSourceVersionId).toMatch(/^src_/);
    const plan = await t.app.inject({ method: "POST", url: `/api/incidents/${inc.json().id}/recovery-plan`, headers: t.auth(t.tokenA), payload: { commandId: newId("command"), replacementSourceVersionId: q.json().suggestedReplacementSourceVersionId } });
    expect(plan.statusCode).toBe(201);
    const s2 = (await t.journal.snapshot(runId))!;
    const approval = Object.values(s2.approvals)[0]!;
    // No scheduler/verifier wired → recovery is honestly unavailable.
    const ap = await t.app.inject({
      method: "POST",
      url: `/api/incidents/${inc.json().id}/approve-recovery`,
      headers: t.auth(t.tokenA),
      payload: { commandId: newId("command"), approvalId: approval.id, planId: plan.json().id, actionDigest: plan.json().planDigest, decision: "APPROVE" },
    });
    expect(ap.statusCode).toBe(503);
    expect(s2.run.status).toBe("CONTAINED");
  });
});

describe("Arena", () => {
  it("join → start → private roles → attack window → real run with queued attack → reveal", async () => {
    const rl = recordingLauncher();
    t = await createTestApp({ launcher: rl.launcher, briefingMs: 50, attackWindowMs: 400 });
    rl.bind(t);
    const { workflow, definition } = await setupProjectAndWorkflow(t);
    const room = (await t.app.inject({ method: "POST", url: "/api/arena/rooms", headers: t.auth(t.tokenA), payload: { commandId: newId("command"), workflowId: workflow.id } })).json();
    expect(room.joinCode).toHaveLength(6);

    const join = (alias: string, code = room.joinCode) =>
      t!.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/join`, payload: { commandId: newId("command"), joinCode: code, displayAlias: alias } });
    expect((await join("x", "ZZZZZZ")).statusCode).toBe(403);
    const p1 = (await join("ana")).json();
    const host = t.auth(room.hostToken);
    expect((await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/start`, headers: host, payload: { commandId: newId("command") } })).statusCode).toBe(409);
    const p2 = (await join("ben")).json();
    expect((await join("ana")).statusCode).toBe(409);

    const pub = (await t.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}` })).json();
    expect(JSON.stringify(pub)).not.toMatch(/ATTACKER|DEFENDER/);

    // Players cannot use host controls.
    expect((await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/start`, headers: t.auth(p1.playerToken), payload: { commandId: newId("command") } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/start`, headers: host, payload: { commandId: newId("command") } })).statusCode).toBe(202);

    const me = async (p: { playerToken: string }) => (await t!.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}/me`, headers: t!.auth(p.playerToken) })).json();
    const [m1, m2] = [await me(p1), await me(p2)];
    expect([m1.role, m2.role].sort()).toEqual(["ATTACKER", "DEFENDER"]);
    const attacker = m1.role === "ATTACKER" ? p1 : p2;
    const defender = attacker === p1 ? p2 : p1;
    expect((await me(defender)).cards).toEqual(expect.arrayContaining(["QUARANTINE", "APPROVE_RECOVERY"]));

    const options = (await t.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}/attack-options`, headers: t.auth(attacker.playerToken) })).json();
    expect(options[0]).toEqual({ id: definition.attackPayloads[0]!.id, card: "POISON_DOCUMENT", label: "inject", targetSourceName: "doc" });
    expect((await t.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}/attack-options`, headers: t.auth(defender.playerToken) })).statusCode).toBe(403);

    const act = (p: { playerToken: string }, body: object) =>
      t!.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/actions`, headers: t!.auth(p.playerToken), payload: body });
    const attackCmd = { commandId: newId("command"), card: "POISON_DOCUMENT", attackPayloadId: options[0].id };
    // Still in BRIEFING
    expect((await act(attacker, attackCmd)).json().outcome).toBe("REJECTED");
    await waitFor(async () => (await t!.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}` })).json().phase === "ATTACK_WINDOW");
    const ok = await act(attacker, { ...attackCmd, commandId: newId("command") });
    expect(ok.json().outcome).toBe("ACCEPTED");
    expect((await act(attacker, { ...attackCmd, commandId: ok.json().commandId })).json().outcome).toBe("DUPLICATE");
    expect((await act(defender, { ...attackCmd, commandId: newId("command") })).json().outcome).toBe("REJECTED");

    await waitFor(() => rl.calls.length === 1);
    expect(rl.calls[0]!.attackPayloadIds).toEqual([options[0].id]);
    await waitFor(async () => (await t!.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}` })).json().phase === "AGENT_EXECUTION");

    // Defender inspects a real source of the real run.
    const runId = rl.calls[0]!.runId;
    await waitFor(async () => Object.keys((await t!.journal.snapshot(runId))?.sources ?? {}).length === 2);
    const src = Object.values((await t.journal.snapshot(runId))!.sources)[0]!;
    const insp = await act(defender, { commandId: newId("command"), card: "INSPECT_SOURCE", sourceVersionId: src.id });
    expect(insp.json()).toMatchObject({ outcome: "ACCEPTED", data: { id: src.id } });

    const reveal = (await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/reveal`, headers: host, payload: { commandId: newId("command") } })).json();
    expect(reveal.attackerPlayerId).toBe(attacker.playerId);
    expect(reveal.score.unsafeActionsExecuted).toBeNull(); // no target audit wired → unknown, not zero
    expect(reveal.score.winner).toBe("NONE");
  });
});

describe("Socket.IO", () => {
  it("rejects unauthenticated sockets; streams snapshot, live events and lastSeq replay", async () => {
    const rl = recordingLauncher();
    t = await createTestApp({ launcher: rl.launcher });
    rl.bind(t);
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = t.app.server.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;

    const anon = connect(url, { transports: ["websocket"], reconnection: false });
    sockets.push(anon);
    await new Promise<void>((res) => anon.on("connect_error", () => res()));

    const { workflow } = await setupProjectAndWorkflow(t);
    const { runId } = (await t.app.inject({ method: "POST", url: "/api/runs", headers: t.auth(t.tokenA), payload: { commandId: newId("command"), workflowId: workflow.id, mode: "PROTECTED" } })).json();
    await waitFor(async () => (await t!.journal.snapshot(runId))?.run.status === "RUNNING");

    const s = connect(url, { transports: ["websocket"], auth: { token: t.tokenA }, reconnection: false });
    sockets.push(s);
    const got: { snapshotSeq?: number; events: RunEvent[] } = { events: [] };
    s.on("run.snapshot", (snap: { lastSeq: number }) => (got.snapshotSeq = snap.lastSeq));
    s.on("run.event", (e: RunEvent) => got.events.push(e));
    const ack = await s.timeout(2000).emitWithAck("run.subscribe", { runId });
    expect(ack).toEqual({ ok: true });
    const base = got.snapshotSeq!;

    await t.journal.append(runId, [{ runId, traceId: newId("trace"), type: "alert.suspicious_content", payload: { targetId: "x", detector: "d", reason: "r", severity: "LOW" } }] as NewRunEvent[]);
    await waitFor(() => got.events.length === 1);
    expect(got.events[0]!.seq).toBe(base + 1);

    // Reconnect with lastSeq replays only what was missed.
    const s2 = connect(url, { transports: ["websocket"], auth: { token: t.tokenA }, reconnection: false });
    sockets.push(s2);
    const replayed: RunEvent[] = [];
    let snapshots = 0;
    s2.on("run.event", (e: RunEvent) => replayed.push(e));
    s2.on("run.snapshot", () => snapshots++);
    await s2.timeout(2000).emitWithAck("run.subscribe", { runId, lastSeq: base - 1 });
    await waitFor(() => replayed.length === 2);
    expect(replayed.map((e) => e.seq)).toEqual([base, base + 1]);
    expect(snapshots).toBe(0);

    // Another operator cannot subscribe.
    const s3 = connect(url, { transports: ["websocket"], auth: { token: t.tokenB }, reconnection: false });
    sockets.push(s3);
    expect(await s3.timeout(2000).emitWithAck("run.subscribe", { runId })).toEqual({ ok: false, error: "not found" });
  });
});
