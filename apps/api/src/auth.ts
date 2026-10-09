import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@bastion/db";
import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors";

export type Actor =
  | { kind: "operator"; userId: string }
  | { kind: "host"; userId: string; roomId: string }
  | { kind: "player"; playerId: string; roomId: string };

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newSecret = (bytes = 32) => randomBytes(bytes).toString("base64url");

export class Authenticator {
  constructor(
    private readonly db: Db,
    /** token → userId, from OPERATOR_TOKENS */
    private readonly operators: Map<string, string>,
  ) {}

  async resolve(token: string | undefined): Promise<Actor | null> {
    if (!token) return null;
    for (const [t, userId] of this.operators) {
      const a = Buffer.from(t);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return { kind: "operator", userId };
    }
    const h = hashToken(token);
    const [room] = await this.db.select().from(schema.arenaRooms).where(eq(schema.arenaRooms.hostTokenHash, h));
    // Tokens die with their room.
    if (room) return room.status === "EXPIRED" ? null : { kind: "host", userId: room.hostId, roomId: room.id };
    const [player] = await this.db.select().from(schema.arenaPlayers).where(eq(schema.arenaPlayers.tokenHash, h));
    if (player) {
      const [r] = await this.db.select({ status: schema.arenaRooms.status }).from(schema.arenaRooms).where(eq(schema.arenaRooms.id, player.roomId));
      return r?.status === "EXPIRED" ? null : { kind: "player", playerId: player.id, roomId: player.roomId };
    }
    return null;
  }

  async fromRequest(req: FastifyRequest): Promise<Actor | null> {
    const h = req.headers.authorization;
    return this.resolve(h?.startsWith("Bearer ") ? h.slice(7) : undefined);
  }
}

export const actorId = (a: Actor) => (a.kind === "player" ? a.playerId : a.userId);

export function requireActor(a: Actor | null): Actor {
  if (!a) throw new HttpError("UNAUTHORIZED", "missing or invalid bearer token");
  return a;
}

export function requireOperator(a: Actor | null): Extract<Actor, { kind: "operator" }> {
  const x = requireActor(a);
  if (x.kind !== "operator") throw new HttpError("FORBIDDEN", "operator token required");
  return x;
}
