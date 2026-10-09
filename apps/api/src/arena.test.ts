import { afterEach, describe, expect, it } from "vitest";
import { newId, type RunLauncher } from "@bastion/contracts";
import { createTestApp, testWorkflowDefinition } from "./testing";

type T = Awaited<ReturnType<typeof createTestApp>>;
let t: T | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Test double: accepts launches without running agents (arena mechanics only). */
const idleLauncher: RunLauncher = { launch: async () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(20);
  }
};

async function room(x: T, players: string[]) {
  const p = await x.app.inject({ method: "POST", url: "/api/projects", headers: x.auth(x.tokenA), payload: { commandId: newId("command"), name: "p" } });
  const wf = await x.app.inject({ method: "POST", url: "/api/workflows", headers: x.auth(x.tokenA), payload: { commandId: newId("command"), projectId: p.json().id, definition: testWorkflowDefinition() } });
  const r: { roomId: string; joinCode: string; hostToken: string } = (
    await x.app.inject({ method: "POST", url: "/api/arena/rooms", headers: x.auth(x.tokenA), payload: { commandId: newId("command"), workflowId: wf.json().id } })
  ).json();
  const joined: { playerId: string; playerToken: string }[] = [];
  for (const alias of players)
    joined.push((await x.app.inject({ method: "POST", url: `/api/arena/rooms/${r.roomId}/join`, payload: { commandId: newId("command"), joinCode: r.joinCode, displayAlias: alias } })).json());
  const host = x.auth(r.hostToken);
  const hostPost = (path: string) => x.app.inject({ method: "POST", url: `/api/arena/rooms/${r.roomId}/${path}`, headers: host, payload: { commandId: newId("command") } });
  const view = async () => (await x.app.inject({ method: "GET", url: `/api/arena/rooms/${r.roomId}` })).json();
  const me = async (pl: { playerToken: string }) => (await x.app.inject({ method: "GET", url: `/api/arena/rooms/${r.roomId}/me`, headers: x.auth(pl.playerToken) })).json();
  return { ...r, players: joined, hostPost, view, me };
}

describe("arena host controls", () => {
  it("pause freezes the clock and actions; resume continues from the remaining time", async () => {
    t = await createTestApp({ launcher: idleLauncher, briefingMs: 300, attackWindowMs: 60_000 });
    const r = await room(t, ["a", "b"]);
    expect((await r.hostPost("start")).statusCode).toBe(202);
    const paused = (await r.hostPost("pause")).json();
    expect(paused).toMatchObject({ phase: "BRIEFING", paused: true, phaseEndsAt: null });
    await sleep(450);
    expect((await r.view()).phase).toBe("BRIEFING");
    const act = await t.app.inject({ method: "POST", url: `/api/arena/rooms/${r.roomId}/actions`, headers: t.auth(r.players[0]!.playerToken), payload: { commandId: newId("command"), card: "INSPECT_SOURCE", sourceVersionId: newId("source") } });
    expect(act.json()).toMatchObject({ outcome: "REJECTED", message: "the round is paused" });
    expect((await r.hostPost("resume")).json().paused).toBe(false);
    await waitFor(async () => (await r.view()).phase === "ATTACK_WINDOW");
    // players cannot use host controls
    expect((await t.app.inject({ method: "POST", url: `/api/arena/rooms/${r.roomId}/pause`, headers: t.auth(r.players[0]!.playerToken), payload: { commandId: newId("command") } })).statusCode).toBe(403);
  });

  it("reset returns to LOBBY with a new round and clears private state", async () => {
    t = await createTestApp({ launcher: idleLauncher });
    const r = await room(t, ["a", "b"]);
    await r.hostPost("start");
    expect((await Promise.all(r.players.map(r.me))).map((m) => m.role).sort()).toEqual(["ATTACKER", "DEFENDER"]);
    const reset = (await r.hostPost("reset")).json();
    expect(reset).toMatchObject({ phase: "LOBBY", round: 2, runId: null });
    for (const m of await Promise.all(r.players.map(r.me))) expect(m).toMatchObject({ role: "DEFENDER", cards: [], usedCards: [], evidence: [] });
    expect((await r.hostPost("start")).statusCode).toBe(202);
    expect((await r.view()).round).toBe(2);
  });

  it("resumeAll re-arms phase timers after a restart (including deadlines that passed while down)", async () => {
    t = await createTestApp({ launcher: idleLauncher, briefingMs: 100 });
    const r = await room(t, ["a", "b"]);
    await r.hostPost("start");
    t.arena.stop(); // simulated crash: timers gone
    await sleep(250);
    expect((await r.view()).phase).toBe("BRIEFING");
    await t.arena.resumeAll();
    await waitFor(async () => (await r.view()).phase === "ATTACK_WINDOW");
  });
});

describe("arena resilience", () => {
  it("moves control cards from a disconnected defender after the grace period, not before", async () => {
    t = await createTestApp({ launcher: idleLauncher, reconnectGraceMs: 120 });
    const r = await room(t, ["a", "b", "c"]);
    await r.hostPost("start");
    const states = await Promise.all(r.players.map(async (p) => ({ p, s: await r.me(p) })));
    const holder = states.find((x) => x.s.cards.includes("APPROVE_RECOVERY"))!;
    const other = states.find((x) => x.s.role === "DEFENDER" && x !== holder)!;
    for (const x of states) await t.arena.playerConnected(x.p.playerId);

    // Blip: reconnects within grace → nothing moves.
    await t.arena.playerDisconnected(holder.p.playerId);
    await sleep(40);
    await t.arena.playerConnected(holder.p.playerId);
    await sleep(200);
    expect((await r.me(holder.p)).cards).toContain("APPROVE_RECOVERY");

    // Real drop → card moves to the connected defender.
    await t.arena.playerDisconnected(holder.p.playerId);
    await waitFor(async () => (await r.me(other.p)).cards.includes("APPROVE_RECOVERY"));
    expect((await r.me(holder.p)).cards).not.toContain("APPROVE_RECOVERY");
  });

  it("expired rooms are swept: tokens revoked, joins refused", async () => {
    t = await createTestApp({ launcher: idleLauncher, roomTtlMs: 100 });
    const r = await room(t, ["a"]);
    await sleep(150);
    expect(await t.arena.sweepExpired()).toEqual([r.roomId]);
    expect((await t.app.inject({ method: "GET", url: `/api/arena/rooms/${r.roomId}/me`, headers: t.auth(r.players[0]!.playerToken) })).statusCode).toBe(401);
    expect((await r.hostPost("start")).statusCode).toBe(401);
    const join = await t.app.inject({ method: "POST", url: `/api/arena/rooms/${r.roomId}/join`, payload: { commandId: newId("command"), joinCode: r.joinCode, displayAlias: "late" } });
    expect(join.statusCode).toBe(410);
  });

  it("rate-limits joins", async () => {
    t = await createTestApp({ launcher: idleLauncher, joinRatePerMinute: 2 });
    const r = await room(t, ["a", "b"]);
    const third = await t.app.inject({ method: "POST", url: `/api/arena/rooms/${r.roomId}/join`, payload: { commandId: newId("command"), joinCode: r.joinCode, displayAlias: "c" } });
    expect(third.statusCode).toBe(429);
  });
});
