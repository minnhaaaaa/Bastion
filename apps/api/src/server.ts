import { providerRoutes } from "./routes/providers";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@bastion/contracts";
import { Authenticator, actorId, type Actor } from "./auth";
import { HttpError } from "./errors";
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
    global: true,
    max: deps.config.security.requestsPerMinute,
    timeWindow: 60_000,
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
  const inFlight = new Map<string, number>();
  const releases = new WeakMap<object, () => void>();
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if (req.method !== "POST") return;
    const actor = await auth.fromRequest(req);
    if (!actor) return;
    const key = actorId(actor);
    const count = inFlight.get(key) ?? 0;
    if (count >= deps.config.security.maxConcurrentExpensiveRequests) throw new HttpError("RATE_LIMITED", "Too many concurrent operations");
    inFlight.set(key, count + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (inFlight.get(key) ?? 1) - 1;
      if (remaining) inFlight.set(key, remaining); else inFlight.delete(key);
    };
    releases.set(req, release);
  });
  app.addHook("onResponse", async req => { releases.get(req)?.(); releases.delete(req); });
  app.addHook("onTimeout", async req => { releases.get(req)?.(); releases.delete(req); });
  const access = new Access(deps);
  const idem = new Idempotency(deps.commands);
  const runs = new RunService(deps, app.log);
  const arena = new ArenaService(deps, runs);

  coreRoutes(app, deps, { auth, access, idem, runs });
  providerRoutes(app, deps, { auth, access });
  arenaRoutes(app, deps, { auth, access, idem, arena });

  let handshakeWindow = Date.now();
  let handshakes = 0;
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { actor: Actor }>(app.server, {
    cors: { origin: trustedOrigins },
    allowRequest: (req, callback) => {
      if (req.headers.origin && !trustedOrigins.includes(req.headers.origin)) return callback(null, false);
      if (Date.now() - handshakeWindow >= 60_000) { handshakeWindow = Date.now(); handshakes = 0; }
      callback(null, ++handshakes <= deps.config.security.requestsPerMinute);
    },
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
