import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@bastion/contracts";
import { Authenticator, type Actor } from "./auth";
import { Access, RunService, type AppDeps } from "./context";
import { errorHandler } from "./errors";
import { Idempotency } from "./idempotency";
import { ArenaService } from "./arena/service";
import { coreRoutes } from "./routes/core";
import { arenaRoutes } from "./routes/arena";
import { attachSockets } from "./sockets";

/**
 * Fastify + Socket.IO control plane. Every response is derived from persisted state.
 */
export async function buildServer(deps: AppDeps, opts: { webOrigin: string; logLevel: string }) {
  const app = Fastify({ logger: { level: opts.logLevel } });
  await app.register(cors, { origin: opts.webOrigin });
  app.setErrorHandler(errorHandler);

  const startedAt = new Date().toISOString();
  app.get("/health", async () => ({
    ok: true,
    startedAt,
    now: new Date().toISOString(),
    runtimeConnected: Boolean(deps.launcher),
    graphConnected: Boolean(deps.graph),
  }));

  const auth = new Authenticator(deps.db, deps.operators);
  const access = new Access(deps);
  const idem = new Idempotency(deps.commands);
  const runs = new RunService(deps, app.log);
  const arena = new ArenaService(deps, runs);

  coreRoutes(app, deps, { auth, access, idem, runs });
  arenaRoutes(app, deps, { auth, access, idem, arena });

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { actor: Actor }>(app.server, {
    cors: { origin: opts.webOrigin },
  });
  attachSockets(io, deps, { auth, access, arena });
  await arena.resumeAll();

  app.addHook("onClose", async () => {
    arena.stop();
    io.close();
  });

  return { app, io, arena };
}
