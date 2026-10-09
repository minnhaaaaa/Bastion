import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@splitbrain/contracts";

/**
 * Fastify control plane (Member 3). Skeleton only:
 *  - routes/   REST endpoints from ARCHITECTURE §8 (Zod-validated, commandId-idempotent)
 *  - sockets/  run.subscribe / room.subscribe fan-out (read-only; no mutations over sockets)
 */
export async function buildServer(opts: { webOrigin: string }) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: opts.webOrigin });

  app.get("/health", async () => ({ ok: true, service: "splitbrain-api" }));

  const io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
    cors: { origin: opts.webOrigin },
  });

  io.on("connection", (socket) => {
    socket.on("run.subscribe", (_req, ack) => ack?.({ ok: false, error: "not implemented" }));
    socket.on("room.subscribe", (_req, ack) => ack?.({ ok: false, error: "not implemented" }));
  });

  return { app, io };
}
