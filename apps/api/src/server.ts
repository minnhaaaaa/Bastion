import { providerRoutes } from "./routes/providers";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
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
export async function buildServer(deps: AppDeps, opts: { webOrigin: string; additionalOrigins?: string[]; logLevel: string }) {
  const app = Fastify({ logger: { level: opts.logLevel } });
  const trustedOrigins = [opts.webOrigin, ...(opts.additionalOrigins ?? [])];
  await app.register(cors, { origin: trustedOrigins });
  app.setErrorHandler(errorHandler);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => Object.assign(new Error(`rate limit exceeded; retry in ${ctx.after}`), { statusCode: 429 }),
  });

  const startedAt = new Date().toISOString();
  app.get("/health", async () => ({
    ok: true,
    startedAt,
    now: new Date().toISOString(),
    runtimeConnected: Boolean(deps.launcher),
    taskPlanningConnected: Boolean(deps.taskPlanner),
    graphConnected: Boolean(deps.graph),
  }));

  const auth = new Authenticator(deps.db, deps.operators);
  const access = new Access(deps);
  const idem = new Idempotency(deps.commands);
  const runs = new RunService(deps, app.log);
  const arena = new ArenaService(deps, runs);

  coreRoutes(app, deps, { auth, access, idem, runs });
  providerRoutes(app, deps, { auth, access });
  arenaRoutes(app, deps, { auth, access, idem, arena });

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { actor: Actor }>(app.server, {
    cors: { origin: trustedOrigins },
  });
  attachSockets(io, deps, { auth, access, arena });
  await arena.resumeAll();
  const sweep = setInterval(() => void arena.sweepExpired().catch((err) => app.log.error({ err }, "room sweep failed")), deps.config.sweepIntervalMs);
  sweep.unref();

  app.addHook("onClose", async () => {
    clearInterval(sweep);
    arena.stop();
    io.close();
  });

  return { app, io, arena };
}
