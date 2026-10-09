/**
 * ARCHITECTURE §14 #6 (role privacy) and #8 (integrity) over real sockets.
 */
import { afterEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { newId, type RunLauncher } from "@bastion/contracts";
import { createTestApp, testWorkflowDefinition } from "./testing";

type T = Awaited<ReturnType<typeof createTestApp>>;
let t: T | undefined;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await t?.close();
  t = undefined;
});

const idleLauncher: RunLauncher = { launch: async () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function liveRoom(x: T, n: number) {
  await x.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(x.app.server.address() as { port: number }).port}`;
  const p = await x.app.inject({ method: "POST", url: "/api/projects", headers: x.auth(x.tokenA), payload: { commandId: newId("command"), name: "p" } });
  const wf = await x.app.inject({ method: "POST", url: "/api/workflows", headers: x.auth(x.tokenA), payload: { commandId: newId("command"), projectId: p.json().id, definition: testWorkflowDefinition() } });
  const room: { roomId: string; joinCode: string; hostToken: string } = (
    await x.app.inject({ method: "POST", url: "/api/arena/rooms", headers: x.auth(x.tokenA), payload: { commandId: newId("command"), workflowId: wf.json().id } })
  ).json();
  const players: { playerId: string; playerToken: string }[] = [];
  for (let i = 0; i < n; i++)
    players.push((await x.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/join`, payload: { commandId: newId("command"), joinCode: room.joinCode, displayAlias: `p${i}` } })).json());

  const listen = async (token: string) => {
    const s = connect(url, { transports: ["websocket"], auth: { token }, reconnection: false });
    sockets.push(s);
    const seen: { event: string; data: unknown }[] = [];
    s.onAny((event, data) => seen.push({ event, data }));
    expect(await s.timeout(2000).emitWithAck("room.subscribe", { roomId: room.roomId })).toEqual({ ok: true });
    return { s, seen };
  };
  return { url, room, players, listen };
}

describe("acceptance #6: role privacy", () => {
  it("no socket learns the attacker before reveal except the attacker", async () => {
    t = await createTestApp({ launcher: idleLauncher, briefingMs: 50, attackWindowMs: 50 });
    const { room, players, listen } = await liveRoom(t, 3);
    const host = await listen(room.hostToken);
    const clients = await Promise.all(players.map((p) => listen(p.playerToken)));

    await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/start`, headers: t.auth(room.hostToken), payload: { commandId: newId("command") } });
    await sleep(400); // through BRIEFING → ATTACK_WINDOW → AGENT_EXECUTION

    const roles = await Promise.all(
      players.map(async (p) => (await t!.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}/me`, headers: t!.auth(p.playerToken) })).json().role as string),
    );
    const attackerIdx = roles.indexOf("ATTACKER");
    expect(attackerIdx).toBeGreaterThanOrEqual(0);
    const attackerId = players[attackerIdx]!.playerId;

    const leaks = (seen: { event: string; data: unknown }[]) => seen.filter((m) => JSON.stringify(m.data).includes("ATTACKER"));
    expect(leaks(host.seen)).toEqual([]);
    clients.forEach((c, i) => {
      if (i === attackerIdx) expect(leaks(c.seen).length).toBeGreaterThan(0); // its own unicast state
      else expect(leaks(c.seen)).toEqual([]);
    });
    // The public REST view never carries roles either.
    expect(JSON.stringify((await t.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}` })).json())).not.toContain("ATTACKER");

    await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/reveal`, headers: t.auth(room.hostToken), payload: { commandId: newId("command") } });
    await sleep(100);
    const reveal = host.seen.find((m) => m.event === "arena.reveal")!.data as { attackerPlayerId: string };
    expect(reveal.attackerPlayerId).toBe(attackerId);
  });
});

describe("acceptance #8: integrity", () => {
  it("forged socket events and roles change nothing", async () => {
    t = await createTestApp({ launcher: idleLauncher });
    const { url, room, players, listen } = await liveRoom(t, 2);
    const before = (await t.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}` })).json();

    // A player emits events that only the server may emit, and made-up mutations.
    const c = await listen(players[0]!.playerToken);
    for (const ev of ["arena.reveal", "arena.phase", "action.result", "player.private_state", "approve-recovery", "quarantine"])
      c.s.emit(ev, { roomId: room.roomId, role: "ATTACKER", phase: "REVEAL", outcome: "ACCEPTED" });
    await sleep(200);
    const after = (await t.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}` })).json();
    expect(after.phase).toBe(before.phase);

    // A player token cannot use operator or host routes.
    const pt = t.auth(players[0]!.playerToken);
    expect((await t.app.inject({ method: "POST", url: `/api/incidents/${newId("incident")}/approve-recovery`, headers: pt, payload: { commandId: newId("command"), approvalId: newId("approval"), planId: newId("plan"), actionDigest: "x", decision: "APPROVE" } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/reveal`, headers: pt, payload: { commandId: newId("command") } })).statusCode).toBe(403);

    // Cards are server-assigned: claiming one you do not hold is rejected.
    await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/start`, headers: t.auth(room.hostToken), payload: { commandId: newId("command") } });
    const me = (await t.app.inject({ method: "GET", url: `/api/arena/rooms/${room.roomId}/me`, headers: pt })).json();
    const forged = me.role === "ATTACKER"
      ? { card: "APPROVE_RECOVERY", incidentId: newId("incident"), approvalId: newId("approval"), planId: newId("plan"), actionDigest: "x" }
      : { card: "POISON_DOCUMENT", attackPayloadId: "x" };
    const res = await t.app.inject({ method: "POST", url: `/api/arena/rooms/${room.roomId}/actions`, headers: pt, payload: { commandId: newId("command"), ...forged } });
    expect(res.json()).toMatchObject({ outcome: "REJECTED", message: "you do not hold this card" });

    // A socket without a valid token is refused outright.
    const anon = connect(url, { transports: ["websocket"], auth: { token: "forged" }, reconnection: false });
    sockets.push(anon);
    await new Promise<void>((r) => anon.on("connect_error", () => r()));
  });
});
