import { eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { schema } from "@bastion/db";
import { piModelCatalog } from "@bastion/runtime-pi";
import type { Access, AppDeps } from "../context";
import { requireOperator, type Authenticator } from "../auth";
import { HttpError } from "../errors";

const Id = z.object({ id: z.string().min(1) });
const Label = z.string().trim().min(1).max(120);
export function providerRoutes(app: FastifyInstance, d: AppDeps, x: { auth: Authenticator; access: Access }) {
  const operator = async (req: Parameters<Authenticator["fromRequest"]>[0]) => requireOperator(await x.auth.fromRequest(req));
  const service = () => { if (!d.providerConnections) throw new HttpError("UNAVAILABLE", "Provider connections are not enabled on this controller"); return d.providerConnections; };
  const oauth = () => { if (!d.chatgptAuth) throw new HttpError("UNAVAILABLE", "ChatGPT sign-in is not enabled on this controller"); return d.chatgptAuth; };
  app.get("/api/provider-connections", async req => {
    const actor = await operator(req);
    return { enabled: !!d.providerConnections, chatgptAvailable: !!d.chatgptAuth, connections: await d.providerConnections?.list(actor.userId) ?? [], catalog: d.providerConnections ? piModelCatalog().map(({ provider, id, name }) => ({ provider, id, name })) : [], controller: d.providerConnections?.controller.authMode === "api-key" ? { provider: d.providerConnections.controller.provider, model: d.providerConnections.controller.model } : null };
  });
  app.post("/api/provider-connections", { logLevel: "silent" }, async (req, reply) => {
    const actor = await operator(req);
    const cmd = z.object({ label: Label, provider: z.string().min(1), model: z.string().min(1), apiKey: z.string().trim().min(1) }).strict().parse(req.body);
    const connection = await service().addApiKey(actor.userId, cmd.label, cmd.provider, cmd.model, cmd.apiKey);
    return reply.code(201).send(connection);
  });
  app.post("/api/provider-connections/controller", async (req, reply) => {
    const actor = await operator(req); const { label } = z.object({ label: Label }).strict().parse(req.body);
    return reply.code(201).send(await service().importController(actor.userId, label));
  });
  app.post("/api/provider-connections/:id/disable", async req => {
    const actor = await operator(req), { id } = Id.parse(req.params);
    await service().disable(actor.userId, id); return { disabled: true };
  });
  app.get("/api/projects/:id/model", async req => {
    const actor = await operator(req), { id } = Id.parse(req.params);
    await x.access.ownProject(actor, id); return { connectionId: await d.providerConnections?.projectDefault(id) ?? null };
  });
  app.post("/api/projects/:id/model", async req => {
    const actor = await operator(req), { id } = Id.parse(req.params);
    await x.access.ownProject(actor, id);
    const { connectionId } = z.object({ connectionId: z.string().min(1) }).strict().parse(req.body);
    await service().own(actor.userId, connectionId);
    await d.db.insert(schema.projectModels).values({ projectId: id, connectionId }).onConflictDoUpdate({ target: schema.projectModels.projectId, set: { connectionId } });
    return { connectionId };
  });
  app.get("/api/workflows/:id/models", async req => {
    const actor = await operator(req), { id } = Id.parse(req.params);
    const { version } = z.object({ version: z.coerce.number().int().positive() }).parse(req.query);
    const workflow = await x.access.ownWorkflow(actor, id, version);
    const bindings = await d.providerConnections?.bindings(workflow.id, workflow.version) ?? {};
    return { bindings, connections: (await d.providerConnections?.list(actor.userId) ?? []).filter(connection => Object.values(bindings).includes(connection.id)) };
  });
  app.post("/api/provider-connections/chatgpt/start", { logLevel: "silent" }, async req => {
    const actor = await operator(req); const cmd = z.object({ label: Label, connectionId: z.string().min(1).optional() }).strict().parse(req.body);
    return oauth().start(actor.userId, cmd.label, cmd.connectionId);
  });
  app.get("/api/provider-connections/chatgpt/:id", { logLevel: "silent" }, async req => {
    const actor = await operator(req), { id } = Id.parse(req.params); return oauth().status(actor.userId, id);
  });
  app.post("/api/provider-connections/chatgpt/:id/complete", { logLevel: "silent" }, async req => {
    const actor = await operator(req), { id } = Id.parse(req.params);
    const { model } = z.object({ model: z.string().min(1) }).strict().parse(req.body);
    return oauth().complete(actor.userId, id, model);
  });
  app.get("/auth/chatgpt/callback", { logLevel: "silent" }, async (req, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    // The public controller listener must not turn the loopback OAuth callback into a remote endpoint.
    if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(req.ip)) throw new HttpError("FORBIDDEN", "Open this callback on the controller computer");
    const query = z.object({ state: z.string().min(1), code: z.string().optional(), client_id: z.string().optional(), error: z.string().optional() }).parse(req.query);
    await oauth().callback(query);
    return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").type("text/plain").send("ChatGPT sign-in received. Return to Bastion, choose an available model, and save the connection. You can close this tab.");
  });
  app.addHook("onClose", async () => d.chatgptAuth?.close());
}
