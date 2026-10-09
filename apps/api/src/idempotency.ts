import type { FastifyReply } from "fastify";
import type { CommandStore } from "@bastion/db";
import { HttpError } from "./errors";

/**
 * Executes a mutation at most once per commandId. A replay by the same actor on the same
 * route returns the stored result; anything else sharing the id is a conflict.
 * Failed commands are not stored, so the client may retry them.
 */
export class Idempotency {
  private readonly inflight = new Map<string, Promise<{ status: number; body: unknown }>>();
  constructor(private readonly store: CommandStore) {}

  async run(
    reply: FastifyReply,
    key: { commandId: string; actorId: string; route: string },
    fn: () => Promise<{ status: number; body: unknown }>,
  ) {
    const existing = await this.store.get(key.commandId);
    if (existing) {
      if (existing.actorId !== key.actorId || existing.route !== key.route)
        throw new HttpError("CONFLICT", "commandId already used for a different command");
      return reply.status(existing.status).header("idempotent-replay", "true").send(existing.body);
    }
    let p = this.inflight.get(key.commandId);
    if (!p) {
      p = fn().then(async (r) => {
        await this.store.put(key.commandId, key.actorId, key.route, r);
        return r;
      });
      this.inflight.set(key.commandId, p);
      p.finally(() => this.inflight.delete(key.commandId)).catch(() => undefined);
    }
    const r = await p;
    return reply.status(r.status).send(r.body);
  }
}
