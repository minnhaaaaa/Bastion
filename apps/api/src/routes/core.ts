import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  ApproveRecoveryCmd,
  CreateProjectCmd,
  CreateRunCmd,
  CreateWorkflowCmd,
  CreateWorkflowVersionCmd,
  OpenIncidentCmd,
  QuarantineCmd,
  RecoveryPlanCmd,
  toGraphView,
} from "@bastion/contracts";
import { computeImpact } from "@bastion/recovery";
import { actorId, requireActor, requireOperator, type Authenticator } from "../auth";
import type { Access, AppDeps, RunService } from "../context";
import { HttpError, notFound } from "../errors";
import type { Idempotency } from "../idempotency";

const IdParam = z.object({ id: z.string().min(1) });

export function coreRoutes(
  app: FastifyInstance,
  d: AppDeps,
  x: { auth: Authenticator; access: Access; idem: Idempotency; runs: RunService },
) {
  const op = async (req: Parameters<Authenticator["fromRequest"]>[0]) => requireOperator(await x.auth.fromRequest(req));
  const any = async (req: Parameters<Authenticator["fromRequest"]>[0]) => requireActor(await x.auth.fromRequest(req));

  // ── Projects ──────────────────────────────────────────────────────────────
  app.post("/api/projects", async (req, reply) => {
    const actor = await op(req);
    const cmd = CreateProjectCmd.parse(req.body);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: "projects.create" }, async () => ({
      status: 201,
      body: await d.projects.create(actor.userId, cmd.name),
    }));
  });

  app.get("/api/projects", async (req) => {
    const actor = await op(req);
    return d.projects.listByOwner(actor.userId);
  });

  // ── Workflows (definitions are data) ─────────────────────────────────────
  app.post("/api/workflows", async (req, reply) => {
    const actor = await op(req);
    const cmd = CreateWorkflowCmd.parse(req.body);
    await x.access.ownProject(actor, cmd.projectId);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: "workflows.create" }, async () => ({
      status: 201,
      body: await d.workflows.create(cmd.projectId, cmd.definition),
    }));
  });

  app.post("/api/workflows/:id/versions", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const cmd = CreateWorkflowVersionCmd.parse(req.body);
    await x.access.ownWorkflow(actor, id);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `workflows.version:${id}` }, async () => ({
      status: 201,
      body: await d.workflows.createVersion(id, cmd.definition),
    }));
  });

  app.get("/api/workflows", async (req) => {
    const actor = await op(req);
    const { projectId } = z.object({ projectId: z.string() }).parse(req.query);
    await x.access.ownProject(actor, projectId);
    return d.workflows.list(projectId);
  });

  app.get("/api/workflows/:id", async (req) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const { version } = z.object({ version: z.coerce.number().int().positive().optional() }).parse(req.query);
    return x.access.ownWorkflow(actor, id, version);
  });

  // ── Runs ─────────────────────────────────────────────────────────────────
  app.post("/api/runs", async (req, reply) => {
    const actor = await op(req);
    const cmd = CreateRunCmd.parse(req.body);
    const wf = await x.access.ownWorkflow(actor, cmd.workflowId);
    x.runs.assertRuntime();
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: "runs.create" }, async () => ({
      status: 201,
      body: { runId: await x.runs.start(wf, cmd.mode, []) },
    }));
  });

  app.get("/api/runs", async (req) => {
    const actor = await op(req);
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.query);
    if (projectId) {
      await x.access.ownProject(actor, projectId);
      return d.runs.list([projectId]);
    }
    return d.runs.list((await d.projects.listByOwner(actor.userId)).map((p) => p.id));
  });

  app.get("/api/runs/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    return x.access.readRun(await any(req), id);
  });

  app.get("/api/runs/:id/events", async (req) => {
    const actor = await any(req);
    const { id } = IdParam.parse(req.params);
    const q = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    await x.access.readRun(actor, id);
    return d.journal.read(id, q.after ?? 0, q.limit ?? 500);
  });

  app.get("/api/runs/:id/graph", async (req) => {
    const { id } = IdParam.parse(req.params);
    const s = await x.access.readRun(await any(req), id);
    return { ...toGraphView(s), lastSeq: s.lastSeq, graphProjectedUpTo: s.graphProjectedUpTo };
  });

  app.get("/api/runs/:id/incidents", async (req) => {
    const { id } = IdParam.parse(req.params);
    const s = await x.access.readRun(await any(req), id);
    return Object.values(s.incidents);
  });

  /** Authoritative impact closure (Postgres), plus the Neo4j view when the graph is caught up. */
  app.get("/api/runs/:id/impact", async (req) => {
    const { id } = IdParam.parse(req.params);
    const { fromId } = z.object({ fromId: z.string().min(1) }).parse(req.query);
    const s = await x.access.readRun(await any(req), id);
    if (!s.sources[fromId] && !s.artifacts[fromId] && !s.executions[fromId]) throw notFound("node");
    const authoritative = computeImpact(s, fromId);
    let graph: { taskIds: string[]; artifactIds: string[] } | null = null;
    if (d.graph && fromId.startsWith("src_")) {
      try {
        if ((await d.graph.projectedUpTo(id)) >= s.lastSeq - 1) graph = await d.graph.impactSet(id, fromId);
      } catch (err) {
        req.log.warn({ err }, "graph impact query failed");
      }
    }
    return { authoritative, graph };
  });

  app.post("/api/runs/:id/incidents", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const cmd = OpenIncidentCmd.parse(req.body);
    await x.access.operatorRun(actor, id);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `incidents.open:${id}` }, async () => ({
      status: 201,
      body: await d.recovery.openIncident({ runId: id, sourceVersionId: cmd.sourceVersionId, severity: cmd.severity, reason: cmd.reason, triggerToolRequestId: null }),
    }));
  });

  // ── Incidents ────────────────────────────────────────────────────────────
  app.post("/api/incidents/:id/quarantine", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const cmd = QuarantineCmd.parse(req.body);
    await x.access.operatorIncident(actor, id);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actorId(actor), route: `incidents.quarantine:${id}` }, async () => {
      await d.recovery.quarantine(id, cmd.sourceVersionId, actor.userId);
      return { status: 200, body: { ok: true, suggestedReplacementSourceVersionId: await d.recovery.suggestReplacement(id) } };
    });
  });

  app.post("/api/incidents/:id/recovery-plan", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const cmd = RecoveryPlanCmd.parse(req.body);
    await x.access.operatorIncident(actor, id);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `incidents.plan:${id}` }, async () => ({
      status: 201,
      body: await d.recovery.plan(id, cmd.replacementSourceVersionId),
    }));
  });

  app.post("/api/incidents/:id/approve-recovery", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const cmd = ApproveRecoveryCmd.parse(req.body);
    const { s } = await x.access.operatorIncident(actor, id);
    if (s.approvals[cmd.approvalId]?.incidentId !== id) throw new HttpError("VALIDATION", "approval does not belong to this incident");
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `incidents.approve:${id}` }, async () => {
      const input = { approvalId: cmd.approvalId, planId: cmd.planId, actionDigest: cmd.actionDigest, actorId: actor.userId };
      if (cmd.decision === "REJECT") await d.recovery.reject(input);
      else await d.recovery.approveAndRecover(input);
      return { status: 202, body: { ok: true, decision: cmd.decision } };
    });
  });
}
