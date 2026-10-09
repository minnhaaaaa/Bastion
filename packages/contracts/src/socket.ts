import { z } from "zod";
import * as Id from "./ids";
import { RunEvent } from "./events";
import { RunSnapshot } from "./snapshot";
import { ActionOutcome, ArenaPhase, ArenaRole, AttackCard, DefenderCard } from "./enums";

/**
 * Socket.IO contract (ARCHITECTURE §8).
 * Sockets are read-only views: every mutation goes through REST. A socket message never authorizes anything.
 */

export const RoomPresence = z.object({
  roomId: Id.RoomId,
  count: z.number().int(),
  /** Public aliases only — no roles before REVEAL. */
  players: z.array(z.object({ playerId: Id.PlayerId, displayAlias: z.string(), connected: z.boolean() })),
});
export type RoomPresence = z.infer<typeof RoomPresence>;

/** Unicast to exactly one player socket. */
export const PlayerPrivateState = z.object({
  roomId: Id.RoomId,
  playerId: Id.PlayerId,
  role: ArenaRole,
  cards: z.array(z.union([AttackCard, DefenderCard])),
  /** Cards already used this round. */
  usedCards: z.array(z.union([AttackCard, DefenderCard])),
  /** Evidence this player has inspected or been shared (ids into the run snapshot). */
  evidence: z.array(z.object({ id: z.string(), kind: z.string(), summary: z.string() })),
});
export type PlayerPrivateState = z.infer<typeof PlayerPrivateState>;

export const ActionResult = z.object({
  commandId: Id.CommandId,
  outcome: ActionOutcome,
  message: z.string(),
  /** Card-specific result, e.g. inspected source preview or traced path. */
  data: z.unknown().optional(),
});
export type ActionResult = z.infer<typeof ActionResult>;

export const ArenaPhaseUpdate = z.object({
  roomId: Id.RoomId,
  runId: Id.RunId.nullable(),
  phase: ArenaPhase,
  /** Server clock; clients compute countdown from these. */
  phaseStartedAt: z.string().datetime(),
  phaseEndsAt: z.string().datetime().nullable(),
  serverNow: z.string().datetime(),
});
export type ArenaPhaseUpdate = z.infer<typeof ArenaPhaseUpdate>;

export const ArenaScore = z.object({
  /** Forbidden operations that actually reached the sandbox target (target-side audit). */
  unsafeActionsExecuted: z.number().int(),
  deniedToolCalls: z.number().int(),
  legitimateTaskCompleted: z.boolean(),
  winner: z.enum(["DEFENDERS", "ATTACKER", "NONE"]),
});
export type ArenaScore = z.infer<typeof ArenaScore>;

export const ArenaReveal = z.object({
  roomId: Id.RoomId,
  attackerPlayerId: Id.PlayerId.nullable(),
  attackerAlias: z.string().nullable(),
  cardsPlayed: z.array(z.object({ playerId: Id.PlayerId, card: z.string(), outcome: ActionOutcome })),
  score: ArenaScore,
});
export type ArenaReveal = z.infer<typeof ArenaReveal>;

export interface ServerToClientEvents {
  "run.snapshot": (snapshot: RunSnapshot) => void;
  "run.event": (event: RunEvent) => void;
  "room.presence": (presence: RoomPresence) => void;
  "player.private_state": (state: PlayerPrivateState) => void;
  "action.result": (result: ActionResult) => void;
  "arena.phase": (update: ArenaPhaseUpdate) => void;
  "arena.reveal": (reveal: ArenaReveal) => void;
}

export const RunSubscribe = z.object({
  runId: Id.RunId,
  /** If set, server replays events with seq > lastSeq; otherwise sends a full run.snapshot. */
  lastSeq: z.number().int().min(0).optional(),
});
export type RunSubscribe = z.infer<typeof RunSubscribe>;

export const RoomSubscribe = z.object({
  roomId: Id.RoomId,
  /** Player token from JoinRoomResult; omitted for the public projector view (host uses hostToken). */
  playerToken: z.string().optional(),
  hostToken: z.string().optional(),
});
export type RoomSubscribe = z.infer<typeof RoomSubscribe>;

export type Ack = (res: { ok: true } | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  "run.subscribe": (req: RunSubscribe, ack?: Ack) => void;
  "run.unsubscribe": (req: { runId: string }) => void;
  "room.subscribe": (req: RoomSubscribe, ack?: Ack) => void;
}
