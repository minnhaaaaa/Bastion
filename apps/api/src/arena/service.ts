import { randomInt } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  latestExecution,
  newId,
  type ActionResult,
  type ArenaActionCmd,
  type ArenaPhase,
  type ArenaPhaseUpdate,
  type ArenaReveal,
  type PlayerPrivateState,
  type RoomPresence,
  type RunEvent,
  type Workflow,
} from "@bastion/contracts";
import { schema } from "@bastion/db";
import { computeImpact } from "@bastion/recovery";
import type { AppDeps, RunService } from "../context";
import { HttpError, notFound } from "../errors";
import { hashToken, newSecret } from "../auth";

type Room = typeof schema.arenaRooms.$inferSelect;
type Player = typeof schema.arenaPlayers.$inferSelect;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
const ATTACK_CARDS = new Set(["POISON_DOCUMENT", "REDIRECT_TOOL", "LEAK_SECRET"]);
/** Controller cards that must stay with a connected defender. */
const CONTROL_CARDS = ["QUARANTINE", "APPROVE_RECOVERY"] as const;
const ENDED: ArenaPhase[] = ["LOBBY", "REVEAL", "COMPLETE"];
const ORDER: ArenaPhase[] = ["LOBBY", "BRIEFING", "ATTACK_WINDOW", "AGENT_EXECUTION", "INVESTIGATION", "CONTAINMENT", "RECOVERY", "REVEAL", "COMPLETE"];
const atOrAfter = (p: ArenaPhase, q: ArenaPhase) => ORDER.indexOf(p) >= ORDER.indexOf(q);

/** Socket side of the arena (implemented in sockets.ts). */
export interface ArenaEmitter {
  phase(roomId: string, u: ArenaPhaseUpdate): void;
  presence(roomId: string, p: RoomPresence): void;
  privateState(playerId: string, s: PlayerPrivateState): void;
  actionResult(playerId: string, r: ActionResult): void;
  reveal(roomId: string, r: ArenaReveal): void;
  /** Disconnect every socket of an expired room. */
  closeRoom(roomId: string): void;
}

const JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const joinCode = () => Array.from({ length: 6 }, () => JOIN_ALPHABET[randomInt(JOIN_ALPHABET.length)]).join("");

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Arena round controller (ARCHITECTURE §9). The server clock and real run events drive phases;
 * player actions are typed commands that map onto real controller operations.
 */
export class ArenaService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly connections = new Map<string, number>();
  private emitter: ArenaEmitter | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly d: AppDeps,
    private readonly runs: RunService,
  ) {
    this.now = d.now ?? (() => new Date());
  }

  attach(emitter: ArenaEmitter) {
    this.emitter = emitter;
  }

  stop() {
    for (const t of [...this.timers.values(), ...this.graceTimers.values()]) clearTimeout(t);
    this.timers.clear();
    this.graceTimers.clear();
  }

  // ── Queries ──────────────────────────────────────────────────────────────
  async room(roomId: string): Promise<Room> {
    const [r] = await this.d.db.select().from(schema.arenaRooms).where(eq(schema.arenaRooms.id, roomId));
    if (!r) throw notFound("room");
    return r;
  }

  private async players(roomId: string): Promise<Player[]> {
    return this.d.db.select().from(schema.arenaPlayers).where(eq(schema.arenaPlayers.roomId, roomId)).orderBy(asc(schema.arenaPlayers.joinedAt));
  }

  private async player(playerId: string): Promise<Player> {
    const [p] = await this.d.db.select().from(schema.arenaPlayers).where(eq(schema.arenaPlayers.id, playerId));
    if (!p) throw notFound("player");
    return p;
  }

  private async workflowOf(room: Room): Promise<Workflow> {
    const wf = await this.d.workflows.get(room.workflowId);
    if (!wf) throw notFound("workflow");
    return wf;
  }

  async presence(roomId: string): Promise<RoomPresence> {
    const ps = await this.players(roomId);
    return { roomId, count: ps.length, players: ps.map((p) => ({ playerId: p.id, displayAlias: p.displayAlias, connected: p.connected })) };
  }

  phaseUpdate(room: Room): ArenaPhaseUpdate {
    return {
      roomId: room.id,
      runId: room.runId,
      phase: room.phase,
      phaseStartedAt: new Date(room.phaseStartedAt).toISOString(),
      phaseEndsAt: room.phaseEndsAt ? new Date(room.phaseEndsAt).toISOString() : null,
      serverNow: this.now().toISOString(),
      paused: room.paused,
      round: room.round,
    };
  }

  async privateState(playerId: string): Promise<PlayerPrivateState> {
    const p = await this.player(playerId);
    return {
      roomId: p.roomId,
      playerId: p.id,
      role: p.role,
      cards: p.cards as PlayerPrivateState["cards"],
      usedCards: p.usedCards as PlayerPrivateState["usedCards"],
      evidence: p.evidence,
    };
  }

  /** Attack payload catalogue for the attacker: labels only, never content. */
  async attackOptions(playerId: string) {
    const p = await this.player(playerId);
    if (p.role !== "ATTACKER") throw new HttpError("FORBIDDEN", "attackers only");
    const room = await this.room(p.roomId);
    if (room.phase === "LOBBY") throw new HttpError("WRONG_PHASE", "round has not started");
    const wf = await this.workflowOf(room);
    return wf.definition.attackPayloads.map(({ id, card, label, targetSourceName }) => ({ id, card, label, targetSourceName }));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  async create(hostId: string, workflow: Workflow) {
    const code = joinCode();
    const hostToken = newSecret();
    const roomId = newId("room");
    const now = this.now();
    await this.d.db.insert(schema.arenaRooms).values({
      id: roomId,
      workflowId: workflow.id,
      joinCodeHash: hashToken(`${roomId}:${code}`),
      hostTokenHash: hashToken(hostToken),
      hostId,
      phase: "LOBBY",
      phaseStartedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.d.config.roomTtlMs).toISOString(),
    });
    return { roomId, joinCode: code, hostToken };
  }

  async join(roomId: string, code: string, alias: string) {
    const room = await this.room(roomId);
    if (room.joinCodeHash !== hashToken(`${roomId}:${code.toUpperCase()}`)) throw new HttpError("FORBIDDEN", "invalid join code");
    if (Date.parse(room.expiresAt) <= this.now().getTime()) throw new HttpError("EXPIRED", "room expired");
    if (room.phase !== "LOBBY") throw new HttpError("WRONG_PHASE", "round already started");
    const ps = await this.players(roomId);
    if (ps.length >= MAX_PLAYERS) throw new HttpError("CONFLICT", `room is full (${MAX_PLAYERS})`);
    if (ps.some((p) => p.displayAlias.toLowerCase() === alias.toLowerCase())) throw new HttpError("CONFLICT", "alias taken");
    const token = newSecret();
    const playerId = newId("player");
    await this.d.db.insert(schema.arenaPlayers).values({
      id: playerId,
      roomId,
      sessionId: newId("trace"),
      tokenHash: hashToken(token),
      // Provisional; real roles are assigned privately at start.
      role: "DEFENDER",
      displayAlias: alias,
    });
    this.emitter?.presence(roomId, await this.presence(roomId));
    return { playerId, playerToken: token };
  }

  private async setConnected(playerId: string, connected: boolean) {
    const p = await this.player(playerId);
    await this.d.db.update(schema.arenaPlayers).set({ connected }).where(eq(schema.arenaPlayers.id, playerId));
    this.emitter?.presence(p.roomId, await this.presence(p.roomId));
  }

  /** A socket for this player subscribed. Multiple tabs/devices are counted. */
  async playerConnected(playerId: string) {
    this.connections.set(playerId, (this.connections.get(playerId) ?? 0) + 1);
    clearTimeout(this.graceTimers.get(playerId));
    this.graceTimers.delete(playerId);
    await this.setConnected(playerId, true);
  }

  /** Last socket gone → offline; after the grace period, hand control cards to a connected defender. */
  async playerDisconnected(playerId: string) {
    const n = (this.connections.get(playerId) ?? 1) - 1;
    if (n > 0) return void this.connections.set(playerId, n);
    this.connections.delete(playerId);
    await this.setConnected(playerId, false);
    clearTimeout(this.graceTimers.get(playerId));
    this.graceTimers.set(
      playerId,
      setTimeout(() => {
        this.graceTimers.delete(playerId);
        void this.reassignControlCards(playerId).catch(() => undefined);
      }, this.d.config.reconnectGraceMs),
    );
  }

  /** Move QUARANTINE / APPROVE_RECOVERY from an offline defender to the connected defender holding fewest cards. */
  async reassignControlCards(playerId: string): Promise<{ card: string; to: string }[]> {
    const p = await this.player(playerId);
    const room = await this.room(p.roomId);
    if (p.connected || p.role !== "DEFENDER" || ENDED.includes(room.phase)) return [];
    const moved: { card: string; to: string }[] = [];
    for (const card of CONTROL_CARDS) {
      if (!p.cards.includes(card)) continue;
      const candidates = (await this.players(room.id))
        .filter((x) => x.id !== p.id && x.role === "DEFENDER" && x.connected && !x.cards.includes(card))
        .sort((a, b) => a.cards.length - b.cards.length);
      const to = candidates[0];
      if (!to) continue; // nobody online: the host/operator console can still act
      const fresh = await this.player(p.id);
      await this.d.db.transaction(async (tx) => {
        await tx.update(schema.arenaPlayers).set({ cards: fresh.cards.filter((c) => c !== card) }).where(eq(schema.arenaPlayers.id, p.id));
        await tx.update(schema.arenaPlayers).set({ cards: [...to.cards, card] }).where(eq(schema.arenaPlayers.id, to.id));
      });
      moved.push({ card, to: to.id });
      this.emitter?.privateState(to.id, await this.privateState(to.id));
    }
    if (moved.length) this.emitter?.privateState(p.id, await this.privateState(p.id));
    return moved;
  }

  // ── Host controls ────────────────────────────────────────────────────────
  async pause(roomId: string) {
    const room = await this.room(roomId);
    if (ENDED.includes(room.phase)) throw new HttpError("WRONG_PHASE", `cannot pause in ${room.phase}`);
    if (room.paused) throw new HttpError("CONFLICT", "already paused");
    clearTimeout(this.timers.get(roomId));
    this.timers.delete(roomId);
    const remaining = room.phaseEndsAt ? Math.max(0, Date.parse(room.phaseEndsAt) - this.now().getTime()) : null;
    await this.d.db.update(schema.arenaRooms).set({ paused: true, pausedRemainingMs: remaining, phaseEndsAt: null }).where(eq(schema.arenaRooms.id, roomId));
    const updated = await this.room(roomId);
    this.emitter?.phase(roomId, this.phaseUpdate(updated));
    return updated;
  }

  async resume(roomId: string) {
    const room = await this.room(roomId);
    if (!room.paused) throw new HttpError("CONFLICT", "not paused");
    const endsAt = room.pausedRemainingMs === null ? null : new Date(this.now().getTime() + room.pausedRemainingMs).toISOString();
    await this.d.db.update(schema.arenaRooms).set({ paused: false, pausedRemainingMs: null, phaseEndsAt: endsAt }).where(eq(schema.arenaRooms.id, roomId));
    const updated = await this.room(roomId);
    this.schedule(updated);
    this.emitter?.phase(roomId, this.phaseUpdate(updated));
    return updated;
  }

  /** Back to LOBBY with the same players and a new round number. Past runs remain in history. */
  async reset(roomId: string) {
    const room = await this.room(roomId);
    if (room.status === "EXPIRED") throw new HttpError("EXPIRED", "room expired");
    clearTimeout(this.timers.get(roomId));
    this.timers.delete(roomId);
    await this.d.db.transaction(async (tx) => {
      await tx
        .update(schema.arenaRooms)
        .set({ phase: "LOBBY", status: "OPEN", runId: null, pendingAttackPayloadIds: [], paused: false, pausedRemainingMs: null, phaseEndsAt: null, phaseStartedAt: this.now().toISOString(), round: room.round + 1 })
        .where(eq(schema.arenaRooms.id, roomId));
      await tx.update(schema.arenaPlayers).set({ role: "DEFENDER", cards: [], usedCards: [], evidence: [] }).where(eq(schema.arenaPlayers.roomId, roomId));
    });
    const updated = await this.room(roomId);
    this.emitter?.phase(roomId, this.phaseUpdate(updated));
    for (const p of await this.players(roomId)) this.emitter?.privateState(p.id, await this.privateState(p.id));
    return updated;
  }

  /** Expire rooms past their TTL: revoke tokens (status EXPIRED), stop timers, close sockets. */
  async sweepExpired(): Promise<string[]> {
    const now = this.now().getTime();
    const rooms = await this.d.db.select().from(schema.arenaRooms);
    const expired = rooms.filter((r) => r.status !== "EXPIRED" && Date.parse(r.expiresAt) <= now);
    for (const r of expired) {
      clearTimeout(this.timers.get(r.id));
      this.timers.delete(r.id);
      await this.d.db.update(schema.arenaRooms).set({ status: "EXPIRED", phaseEndsAt: null }).where(eq(schema.arenaRooms.id, r.id));
      this.emitter?.closeRoom(r.id);
    }
    return expired.map((r) => r.id);
  }

  async start(roomId: string) {
    const room = await this.room(roomId);
    if (room.phase !== "LOBBY") throw new HttpError("WRONG_PHASE", `room is in ${room.phase}`);
    this.runs.assertRuntime();
    const ps = await this.players(roomId);
    if (ps.length < MIN_PLAYERS) throw new HttpError("CONFLICT", `need at least ${MIN_PLAYERS} players`);
    const wf = await this.workflowOf(room);

    const [attacker, ...defenders] = shuffle(ps);
    const attackCards = [...new Set(wf.definition.attackPayloads.map((p) => p.card))];
    const defenderCards = new Map<string, Set<string>>(defenders.map((p) => [p.id, new Set(["INSPECT_SOURCE", "SHARE_EVIDENCE"])]));
    const ids = defenders.map((p) => p.id);
    if (ids.length === 1) {
      for (const c of ["TRACE_DEPENDENCY", "REVIEW_TOOL_DECISION", "QUARANTINE", "APPROVE_RECOVERY"]) defenderCards.get(ids[0]!)!.add(c);
    } else {
      ["TRACE_DEPENDENCY", "REVIEW_TOOL_DECISION"].forEach((c, i) => defenderCards.get(ids[i % ids.length]!)!.add(c));
      defenderCards.get(ids[0]!)!.add("QUARANTINE");
      defenderCards.get(ids[1]!)!.add("APPROVE_RECOVERY");
    }
    await this.d.db.transaction(async (tx) => {
      await tx.update(schema.arenaPlayers).set({ role: "ATTACKER", cards: attackCards }).where(eq(schema.arenaPlayers.id, attacker!.id));
      for (const p of defenders)
        await tx.update(schema.arenaPlayers).set({ role: "DEFENDER", cards: [...defenderCards.get(p.id)!] }).where(eq(schema.arenaPlayers.id, p.id));
    });
    for (const p of ps) this.emitter?.privateState(p.id, await this.privateState(p.id));
    await this.enterPhase(roomId, "BRIEFING", this.d.config.briefingMs);
  }

  private async enterPhase(roomId: string, phase: ArenaPhase, durationMs: number | null) {
    const now = this.now();
    const room = await this.room(roomId);
    if (room.phase === phase) return room;
    await this.d.db
      .update(schema.arenaRooms)
      .set({
        phase,
        status: room.status === "EXPIRED" ? "EXPIRED" : phase === "LOBBY" ? "OPEN" : phase === "REVEAL" || phase === "COMPLETE" ? "FINISHED" : "IN_PROGRESS",
        phaseStartedAt: now.toISOString(),
        phaseEndsAt: durationMs ? new Date(now.getTime() + durationMs).toISOString() : null,
      })
      .where(eq(schema.arenaRooms.id, roomId));
    const updated = await this.room(roomId);
    this.emitter?.phase(roomId, this.phaseUpdate(updated));
    this.schedule(updated);
    return updated;
  }

  /** (Re)arm the timer for timed phases. Called on phase entry and on server boot. */
  schedule(room: Room) {
    clearTimeout(this.timers.get(room.id));
    this.timers.delete(room.id);
    if (!room.phaseEndsAt || room.paused || room.status === "EXPIRED") return;
    const delay = Math.max(0, Date.parse(room.phaseEndsAt) - this.now().getTime());
    this.timers.set(
      room.id,
      setTimeout(() => void this.onTimer(room.id, room.phase).catch(() => undefined), delay),
    );
  }

  async resumeAll() {
    const rooms = await this.d.db.select().from(schema.arenaRooms).where(inArray(schema.arenaRooms.phase, ["BRIEFING", "ATTACK_WINDOW"]));
    for (const r of rooms) this.schedule(r);
  }

  private async onTimer(roomId: string, expected: ArenaPhase) {
    const room = await this.room(roomId);
    if (room.phase !== expected || room.paused || room.status === "EXPIRED") return;
    if (expected === "BRIEFING") await this.enterPhase(roomId, "ATTACK_WINDOW", this.d.config.attackWindowMs);
    else if (expected === "ATTACK_WINDOW") await this.beginExecution(roomId);
  }

  /** Attack window closed: start the real run with whatever the attacker queued. */
  private async beginExecution(roomId: string) {
    const room = await this.room(roomId);
    const wf = await this.workflowOf(room);
    const runId = await this.runs.start(wf, "PROTECTED", room.pendingAttackPayloadIds);
    await this.d.db.update(schema.arenaRooms).set({ runId }).where(eq(schema.arenaRooms.id, roomId));
    await this.enterPhase(roomId, "AGENT_EXECUTION", null);
  }

  /** Real run events advance the round. */
  async onRunEvent(e: RunEvent) {
    const next: Partial<Record<RunEvent["type"], ArenaPhase>> = {
      "incident.opened": "INVESTIGATION",
      "incident.quarantined": "CONTAINMENT",
      "recovery.started": "RECOVERY",
    };
    let phase = next[e.type];
    if (e.type === "run.status_changed" && ["COMPLETED", "FAILED"].includes(e.payload.to)) phase = "INVESTIGATION";
    if (!phase) return;
    const rooms = await this.d.db.select().from(schema.arenaRooms).where(eq(schema.arenaRooms.runId, e.runId));
    for (const r of rooms) if (!atOrAfter(r.phase, phase)) await this.enterPhase(r.id, phase, null);
  }

  async reveal(roomId: string): Promise<ArenaReveal> {
    const room = await this.room(roomId);
    if (!room.runId || !atOrAfter(room.phase, "AGENT_EXECUTION")) throw new HttpError("WRONG_PHASE", "nothing to reveal before the agents run");
    const s = (await this.d.journal.snapshot(room.runId))!;
    const ps = await this.players(roomId);
    const attacker = ps.find((p) => p.role === "ATTACKER") ?? null;
    const actions = await this.d.db
      .select()
      .from(schema.arenaActions)
      .where(and(eq(schema.arenaActions.roomId, roomId), eq(schema.arenaActions.round, room.round), eq(schema.arenaActions.outcome, "ACCEPTED")))
      .orderBy(asc(schema.arenaActions.createdAt));
    const unsafe = this.d.audit ? await this.d.audit.unsafeAccessCount(room.runId) : null;
    const tasks = Object.keys(s.tasks);
    const legit =
      tasks.length > 0 &&
      tasks.every((t) => {
        const ex = latestExecution(s, t);
        return ex?.state === "SUCCEEDED" && ex.securityState === "CLEAR";
      });
    const reveal: ArenaReveal = {
      roomId,
      attackerPlayerId: attacker?.id ?? null,
      attackerAlias: attacker?.displayAlias ?? null,
      cardsPlayed: actions.map((a) => ({ playerId: a.playerId, card: a.type, outcome: a.outcome })),
      score: {
        unsafeActionsExecuted: unsafe,
        deniedToolCalls: Object.values(s.toolRequests).filter((t) => t.decision === "DENY").length,
        legitimateTaskCompleted: legit,
        winner: unsafe === null ? "NONE" : unsafe > 0 ? "ATTACKER" : legit ? "DEFENDERS" : "NONE",
      },
    };
    await this.enterPhase(roomId, "REVEAL", null);
    this.emitter?.reveal(roomId, reveal);
    return reveal;
  }

  // ── Player actions ───────────────────────────────────────────────────────
  async act(playerId: string, cmd: ArenaActionCmd): Promise<ActionResult> {
    const [prior] = await this.d.db.select().from(schema.arenaActions).where(eq(schema.arenaActions.commandId, cmd.commandId));
    if (prior) {
      if (prior.playerId !== playerId) throw new HttpError("CONFLICT", "commandId already used");
      return { commandId: cmd.commandId, outcome: "DUPLICATE", message: prior.message };
    }
    const p = await this.player(playerId);
    const room = await this.room(p.roomId);
    let result: ActionResult;
    try {
      if (room.status === "EXPIRED") throw new Error("room expired");
      if (room.paused) throw new Error("the round is paused");
      const data = await this.perform(p, room, cmd);
      result = { commandId: cmd.commandId, outcome: "ACCEPTED", message: `${cmd.card} accepted`, ...(data === undefined ? {} : { data }) };
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      result = { commandId: cmd.commandId, outcome: "REJECTED", message: err.message };
    }
    await this.d.db
      .insert(schema.arenaActions)
      .values({ id: newId("command"), roomId: room.id, playerId, commandId: cmd.commandId, type: cmd.card, outcome: result.outcome, message: result.message, round: room.round })
      .onConflictDoNothing();
    this.emitter?.actionResult(playerId, result);
    this.emitter?.privateState(playerId, await this.privateState(playerId));
    return result;
  }

  private async perform(p: Player, room: Room, cmd: ArenaActionCmd): Promise<unknown> {
    if (!p.cards.includes(cmd.card)) throw new Error("you do not hold this card");
    if (ATTACK_CARDS.has(cmd.card)) {
      if (p.role !== "ATTACKER") throw new Error("attackers only");
      if (room.phase !== "ATTACK_WINDOW") throw new Error("attacks are only accepted during the attack window");
      if (p.usedCards.includes(cmd.card)) throw new Error("card already used");
      const payloadId = (cmd as { attackPayloadId: string }).attackPayloadId;
      const wf = await this.workflowOf(room);
      const payload = wf.definition.attackPayloads.find((x) => x.id === payloadId && x.card === cmd.card);
      if (!payload) throw new Error("unknown attack payload for this card");
      await this.d.db.update(schema.arenaRooms).set({ pendingAttackPayloadIds: [...room.pendingAttackPayloadIds, payload.id] }).where(eq(schema.arenaRooms.id, room.id));
      await this.d.db.update(schema.arenaPlayers).set({ usedCards: [...p.usedCards, cmd.card] }).where(eq(schema.arenaPlayers.id, p.id));
      return { queued: payload.label };
    }

    if (p.role !== "DEFENDER") throw new Error("defenders only");
    if (!room.runId) throw new Error("the agents have not started yet");
    const s = (await this.d.journal.snapshot(room.runId))!;
    const addEvidence = async (playerIds: string[], item: { id: string; kind: string; summary: string }) => {
      for (const id of playerIds) {
        const target = await this.player(id);
        if (target.evidence.some((e) => e.id === item.id)) continue;
        await this.d.db.update(schema.arenaPlayers).set({ evidence: [...target.evidence, item] }).where(eq(schema.arenaPlayers.id, id));
        if (id !== p.id) this.emitter?.privateState(id, await this.privateState(id));
      }
    };

    switch (cmd.card) {
      case "INSPECT_SOURCE": {
        const src = s.sources[cmd.sourceVersionId];
        if (!src) throw new Error("unknown source");
        const data = { id: src.id, name: src.name, version: src.version, trust: src.trust, securityState: src.securityState, preview: src.preview };
        await addEvidence([p.id], { id: src.id, kind: "source", summary: `${src.name} v${src.version} (${src.trust}): ${src.preview}`.slice(0, 280) });
        return data;
      }
      case "TRACE_DEPENDENCY": {
        if (!s.sources[cmd.fromId] && !s.artifacts[cmd.fromId] && !s.executions[cmd.fromId]) throw new Error("unknown node");
        const impact = computeImpact(s, cmd.fromId);
        await addEvidence([p.id], { id: `trace:${cmd.fromId}`, kind: "trace", summary: `${cmd.fromId} → ${impact.taskIds.length} task(s), ${impact.artifactIds.length} artifact(s)` });
        return impact;
      }
      case "REVIEW_TOOL_DECISION": {
        const t = s.toolRequests[cmd.toolRequestId];
        if (!t) throw new Error("unknown tool request");
        const data = { id: t.id, tool: t.toolName, target: t.destination ?? t.resource, decision: t.decision, ruleId: t.policyRuleId, reason: t.reason };
        await addEvidence([p.id], { id: t.id, kind: "tool", summary: `${t.toolName} → ${data.target}: ${t.decision} (${t.policyRuleId})` });
        return data;
      }
      case "SHARE_EVIDENCE": {
        const item = p.evidence.find((e) => e.id === cmd.evidenceId);
        if (!item) throw new Error("you can only share evidence you hold");
        const defenders = (await this.players(room.id)).filter((x) => x.role === "DEFENDER").map((x) => x.id);
        await addEvidence(defenders, item);
        return { sharedWith: defenders.length - 1 };
      }
      case "QUARANTINE": {
        if (s.incidents[cmd.incidentId]?.runId !== room.runId) throw new Error("unknown incident");
        await this.d.recovery.quarantine(cmd.incidentId, cmd.sourceVersionId, p.id);
        const replacement = await this.d.recovery.suggestReplacement(cmd.incidentId);
        const plan = replacement ? await this.d.recovery.plan(cmd.incidentId, replacement) : null;
        return { planned: plan !== null, planId: plan?.id ?? null };
      }
      case "APPROVE_RECOVERY": {
        if (s.incidents[cmd.incidentId]?.runId !== room.runId) throw new Error("unknown incident");
        if (s.approvals[cmd.approvalId]?.incidentId !== cmd.incidentId) throw new Error("approval does not belong to this incident");
        await this.d.recovery.approveAndRecover({ approvalId: cmd.approvalId, planId: cmd.planId, actionDigest: cmd.actionDigest, actorId: p.id });
        return { approved: true };
      }
      default:
        throw new Error("unsupported card");
    }
  }
}
