import type { Server, Socket } from "socket.io";
import {
  RoomSubscribe,
  RunSubscribe,
  type ClientToServerEvents,
  type RunEvent,
  type ServerToClientEvents,
} from "@bastion/contracts";
import type { Actor, Authenticator } from "./auth";
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

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown })?.token;
    const actor = await x.auth.resolve(typeof token === "string" ? token : undefined).catch(() => null);
    if (!actor) return next(new Error("unauthorized"));
    socket.data.actor = actor;
    next();
  });

  const send = (sub: Sub, e: RunEvent) => {
    if (e.seq <= sub.sentUpTo) return;
    sub.sentUpTo = e.seq;
    sub.socket.emit("run.event", e);
  };

  d.journal.onCommitted((e) => {
    for (const sub of runSubs.get(e.runId) ?? []) {
      if (sub.syncing) sub.buffer.push(e);
      else send(sub, e);
    }
    void x.arena.onRunEvent(e).catch((err) => io.engine.emit("error", err));
  });

  io.on("connection", (socket: Sock) => {
    const mine = new Map<string, Sub>();
    const playerRooms = new Set<string>();

    socket.on("run.subscribe", async (raw, ack) => {
      const req = RunSubscribe.safeParse(raw);
      if (!req.success) return ack?.({ ok: false, error: "invalid request" });
      const { runId, lastSeq } = req.data;
      if (!(await x.access.canReadRun(socket.data.actor, runId))) return ack?.({ ok: false, error: "not found" });

      mine.get(runId) && runSubs.get(runId)?.delete(mine.get(runId)!);
      const sub: Sub = { socket, syncing: true, buffer: [], sentUpTo: 0 };
      mine.set(runId, sub);
      (runSubs.get(runId) ?? runSubs.set(runId, new Set()).get(runId)!).add(sub);

      const snapshot = await d.journal.snapshot(runId);
      if (!snapshot) return ack?.({ ok: false, error: "not found" });
      if (lastSeq !== undefined && lastSeq <= snapshot.lastSeq) {
        sub.sentUpTo = lastSeq;
        for (const e of await d.journal.read(runId, lastSeq)) send(sub, e);
      } else {
        sub.sentUpTo = snapshot.lastSeq;
        socket.emit("run.snapshot", snapshot);
      }
      for (const e of sub.buffer) send(sub, e);
      sub.buffer = [];
      sub.syncing = false;
      ack?.({ ok: true });
    });

    socket.on("run.unsubscribe", ({ runId }) => {
      const sub = mine.get(runId);
      if (sub) runSubs.get(runId)?.delete(sub);
      mine.delete(runId);
    });

    socket.on("room.subscribe", async (raw, ack) => {
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
      for (const [runId, sub] of mine) runSubs.get(runId)?.delete(sub);
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
