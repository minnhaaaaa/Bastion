import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../context";
import { requireOperator, type Authenticator } from "../auth";
import { HttpError } from "../errors";

export function githubRoutes(app: FastifyInstance, d: AppDeps, auth: Authenticator) {
  const service = () => { if (!d.githubAuth) throw new HttpError("UNAVAILABLE", "GitHub OAuth is not configured on this controller"); return d.githubAuth; };
  const owner = async (req: Parameters<Authenticator["fromRequest"]>[0]) => (requireOperator(await auth.fromRequest(req))).userId;
  app.get("/api/github/connection", { logLevel: "silent" }, async req => {
    const id = await owner(req);
    return { configured: !!d.githubAuth, scope: d.githubAuth?.config.scope, connection: await d.githubAuth?.connection(id) ?? null };
  });
  app.post("/api/github/start", { logLevel: "silent" }, async req => service().start(await owner(req)));
  app.get("/api/github/attempts/:id", { logLevel: "silent" }, async req => service().status(await owner(req), z.object({ id: z.string().min(1) }).parse(req.params).id));
  app.post("/api/github/attempts/:id/complete", { logLevel: "silent" }, async req => service().complete(await owner(req), z.object({ id: z.string().min(1) }).parse(req.params).id));
  app.post("/api/github/disconnect", { logLevel: "silent" }, async req => { await service().disconnect(await owner(req)); return { disconnected: true }; });
  app.get("/auth/github/callback", { logLevel: "silent" }, async (req, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const query = z.object({ state: z.string().min(1), code: z.string().optional(), error: z.string().optional() }).parse(req.query);
    await service().callback(query);
    return reply.type("text/plain").send("GitHub authorization received. Return to Bastion and confirm the displayed GitHub account. You can close this tab.");
  });
  app.addHook("onClose", async () => d.githubAuth?.close());
}
