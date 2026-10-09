import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ArenaActionCmd, CreateRoomCmd, JoinRoomCmd, RevealCmd, StartRoundCmd } from "@bastion/contracts";
import { requireActor, requireOperator, type Actor, type Authenticator } from "../auth";
import type { Access, AppDeps } from "../context";
import type { ArenaService } from "../arena/service";
import { HttpError } from "../errors";
import type { Idempotency } from "../idempotency";

const IdParam = z.object({ id: z.string().min(1) });

function requireHost(a: Actor | null, roomId: string) {
  const x = requireActor(a);
  if (x.kind !== "host" || x.roomId !== roomId) throw new HttpError("FORBIDDEN", "host token for this room required");
  return x;
}

function requirePlayer(a: Actor | null, roomId: string) {
  const x = requireActor(a);
  if (x.kind !== "player" || x.roomId !== roomId) throw new HttpError("FORBIDDEN", "player token for this room required");
  return x;
}

export function arenaRoutes(
  app: FastifyInstance,
  _d: AppDeps,
  x: { auth: Authenticator; access: Access; idem: Idempotency; arena: ArenaService },
) {
  app.post("/api/arena/rooms", async (req, reply) => {
    const actor = requireOperator(await x.auth.fromRequest(req));
    const cmd = CreateRoomCmd.parse(req.body);
    const wf = await x.access.ownWorkflow(actor, cmd.workflowId);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: "arena.rooms.create" }, async () => ({
      status: 201,
      body: await x.arena.create(actor.userId, wf),
    }));
  });

  /** Public room view: phase + aliases. Never roles. */
  app.get("/api/arena/rooms/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const room = await x.arena.room(id);
    return { ...x.arena.phaseUpdate(room), presence: await x.arena.presence(id) };
  });

  // Join is unauthenticated (QR code). commandId is not stored: replays are rejected by alias uniqueness.
  app.post("/api/arena/rooms/:id/join", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const cmd = JoinRoomCmd.parse(req.body);
    return reply.status(201).send(await x.arena.join(id, cmd.joinCode, cmd.displayAlias));
  });

  app.get("/api/arena/rooms/:id/me", async (req) => {
    const { id } = IdParam.parse(req.params);
    const p = requirePlayer(await x.auth.fromRequest(req), id);
    return x.arena.privateState(p.playerId);
  });

  app.get("/api/arena/rooms/:id/attack-options", async (req) => {
    const { id } = IdParam.parse(req.params);
    const p = requirePlayer(await x.auth.fromRequest(req), id);
    return x.arena.attackOptions(p.playerId);
  });

  app.post("/api/arena/rooms/:id/start", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const host = requireHost(await x.auth.fromRequest(req), id);
    const cmd = StartRoundCmd.parse(req.body);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: host.userId, route: `arena.start:${id}` }, async () => {
      await x.arena.start(id);
      return { status: 202, body: x.arena.phaseUpdate(await x.arena.room(id)) };
    });
  });

  app.post("/api/arena/rooms/:id/reveal", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const host = requireHost(await x.auth.fromRequest(req), id);
    const cmd = RevealCmd.parse(req.body);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: host.userId, route: `arena.reveal:${id}` }, async () => ({
      status: 200,
      body: await x.arena.reveal(id),
    }));
  });

  app.post("/api/arena/rooms/:id/actions", async (req) => {
    const { id } = IdParam.parse(req.params);
    const p = requirePlayer(await x.auth.fromRequest(req), id);
    return x.arena.act(p.playerId, ArenaActionCmd.parse(req.body));
  });
}
