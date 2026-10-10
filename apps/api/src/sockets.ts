import type { Server, Socket } from "socket.io";
import { publicEvent, publicSnapshot } from "./public-view";
import {
  RoomSubscribe,
  RunSubscribe,
  type ClientToServerEvents,
  type RunEvent,
  type ServerToClientEvents,
} from "@bastion/contracts";
import { actorId, type Actor, type Authenticator } from "./auth";
import type { Access, AppDeps } from "./context";
import type { ArenaEmitter, ArenaService } from "./arena/service";

type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { actor: Actor }>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { actor: Actor }>;

/** Per-socket run subscription. While syncing, live events are buffered so none are lost or reordered. */
type Sub = { socket: Sock; syncing: boolean; buffer: RunEvent[]; sentUpTo: number };

/**
 * Read-only fan-out. Every mutation goes through REST; nothing received here changes state.
 */
export function attachSockets(io: IO, d: AppDeps, x: { auth: Authenticator; access: Access; arena: ArenaService }) {
  const runSubs = new Map<string, Set<Sub>>();
  const counts = new Map<string, number>();
  const deadlines = new WeakMap<Sock, number>();
  const budget = d.config.security;
  const removeSubscription = (runId: string, sub: Sub) => {
    const subscribers = runSubs.get(runId);
    subscribers?.delete(sub);
    if (!subscribers?.size) runSubs.delete(runId);
  };

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown })?.token;
    const actor = await x.auth.resolve(typeof token === "string" ? token : undefined).catch(() => null);
    if (!actor) return next(new Error("unauthorized"));
    if (actor.kind !== "operator") {
      try { deadlines.set(socket, Date.parse((await x.arena.room(actor.roomId)).expiresAt)); }
      catch { return next(new Error("unauthorized")); }
    }
    const key = actorId(actor);
    if ((counts.get(key) ?? 0) >= budget.maxSocketsPerActor) return next(new Error("connection quota reached"));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    socket.once("disconnect", () => {
      const count = (counts.get(key) ?? 1) - 1;
      if (count) counts.set(key, count); else counts.delete(key);
    });
    socket.data.actor = actor;
    next();
  });

  const send = (sub: Sub, e: RunEvent) => {
    if (!sub.socket.connected || Date.now() >= (deadlines.get(sub.socket) ?? Infinity)) { sub.socket.disconnect(true); return; }
    if (e.seq <= sub.sentUpTo) return;
    sub.sentUpTo = e.seq;
    sub.socket.emit("run.event", e);
  };

  d.journal.onCommitted(async (raw) => {
    const snapshot = await d.journal.snapshot(raw.runId);
    if (!snapshot) return;
    const e = publicEvent(raw, snapshot);
    for (const sub of runSubs.get(e.runId) ?? []) {
      if (sub.syncing) {
        if (sub.buffer.length >= budget.maxBufferedEvents) sub.socket.disconnect(true);
        else sub.buffer.push(e);
      }
      else send(sub, e);
    }
    void x.arena.onRunEvent(e).catch((err) => console.error("Arena event processing failed", err));
  });

  io.on("connection", (socket: Sock) => {
    const mine = new Map<string, Sub>();
    const playerRooms = new Set<string>();
    const deadline = deadlines.get(socket);
    const expiryTimer = deadline === undefined ? undefined : setTimeout(() => socket.disconnect(true), Math.min(deadline - Date.now(), 2 ** 31 - 1));
    if (socket.data.actor.kind !== "operator") void socket.join(`room:${socket.data.actor.roomId}`);
    let windowStart = Date.now();
    let messages = 0;
    socket.use((_packet, next) => {
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); messages = 0; }
      if (++messages > budget.socketMessagesPerMinute || Date.now() >= (deadline ?? Infinity)) {
        socket.disconnect(true); return next(new Error("subscription expired or rate limited"));
      }
      void x.auth.resolve((socket.handshake.auth as { token?: string }).token).then(actor => {
        if (!actor) { socket.disconnect(true); next(new Error("unauthorized")); }
        else next();
      }).catch(() => { socket.disconnect(true); next(new Error("unauthorized")); });
    });
    let subscribing = false;

    socket.on("run.subscribe", async (raw, acknowledgement) => {
      const ack = typeof acknowledgement === "function" ? acknowledgement : undefined;
      if (subscribing) return ack?.({ ok: false, error: "subscription in progress" });
      subscribing = true;
      try {
        const req = RunSubscribe.safeParse(raw);
        if (!req.success) return ack?.({ ok: false, error: "invalid request" });
        const { runId, lastSeq } = req.data;
        if (!(await x.access.canReadRun(socket.data.actor, runId))) return ack?.({ ok: false, error: "not found" });
        if (!mine.has(runId) && mine.size >= budget.maxRunSubscriptions) return ack?.({ ok: false, error: "subscription quota reached" });

        if (mine.has(runId)) removeSubscription(runId, mine.get(runId)!);
        const sub: Sub = { socket, syncing: true, buffer: [], sentUpTo: 0 };
        mine.set(runId, sub);
        (runSubs.get(runId) ?? runSubs.set(runId, new Set()).get(runId)!).add(sub);

        const snapshot = await d.journal.snapshot(runId);
        if (!snapshot) { removeSubscription(runId, sub); mine.delete(runId); return ack?.({ ok: false, error: "not found" }); }
        if (!socket.connected) return;
        if (lastSeq !== undefined && lastSeq <= snapshot.lastSeq && snapshot.lastSeq - lastSeq <= budget.maxReplayEvents) {
          sub.sentUpTo = lastSeq;
          for (const e of await d.journal.read(runId, lastSeq, budget.maxReplayEvents)) send(sub, publicEvent(e, snapshot));
        } else {
          sub.sentUpTo = snapshot.lastSeq;
          socket.emit("run.snapshot", publicSnapshot(snapshot));
        }
        for (const e of sub.buffer) send(sub, e);
        sub.buffer = [];
        sub.syncing = false;
        ack?.({ ok: true });
      } catch { socket.disconnect(true); }
      finally { subscribing = false; }
    });

    socket.on("run.unsubscribe", raw => {
      const req = RunSubscribe.safeParse(raw);
      if (!req.success) return;
      const { runId } = req.data;
      const sub = mine.get(runId);
      if (sub) removeSubscription(runId, sub);
      mine.delete(runId);
    });

    socket.on("room.subscribe", async (raw, acknowledgement) => {
      const ack = typeof acknowledgement === "function" ? acknowledgement : undefined;
      const req = RoomSubscribe.safeParse(raw);
      if (!req.success) return ack?.({ ok: false, error: "invalid request" });
      const actor = socket.data.actor;
      const { roomId } = req.data;
      const isHost = actor.kind === "host" && actor.roomId === roomId;
      const isPlayer = actor.kind === "player" && actor.roomId === roomId;
      if (!isHost && !isPlayer) return ack?.({ ok: false, error: "forbidden" });
      try {
        const room = await x.arena.room(roomId);
        await socket.join(`room:${roomId}`);
        if (isPlayer) {
          await socket.join(`player:${actor.playerId}`);
          if (!playerRooms.has(actor.playerId)) {
            playerRooms.add(actor.playerId);
            await x.arena.playerConnected(actor.playerId);
          }
          socket.emit("player.private_state", await x.arena.privateState(actor.playerId));
        }
        socket.emit("arena.phase", x.arena.phaseUpdate(room));
        socket.emit("room.presence", await x.arena.presence(roomId));
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: "not found" });
      }
    });

    socket.on("disconnect", () => {
      clearTimeout(expiryTimer);
      for (const [runId, sub] of mine) removeSubscription(runId, sub);
      for (const playerId of playerRooms) void x.arena.playerDisconnected(playerId).catch(() => undefined);
    });
  });

  const emitter: ArenaEmitter = {
    phase: (roomId, u) => io.to(`room:${roomId}`).emit("arena.phase", u),
    presence: (roomId, p) => io.to(`room:${roomId}`).emit("room.presence", p),
    privateState: (playerId, s) => io.to(`player:${playerId}`).emit("player.private_state", s),
    actionResult: (playerId, r) => io.to(`player:${playerId}`).emit("action.result", r),
    reveal: (roomId, r) => io.to(`room:${roomId}`).emit("arena.reveal", r),
    closeRoom: (roomId) => io.in(`room:${roomId}`).disconnectSockets(true),
  };
  x.arena.attach(emitter);
}
