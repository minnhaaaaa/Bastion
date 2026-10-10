import { redactText } from "@bastion/provenance";
import { publicEvent } from "../public-view";
import { TaskDocument, attachTaskSources } from "../task-attachments";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema } from "@bastion/db";
import { RepositorySelection, RepositoryAccess } from "../repository-access";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  ApproveRecoveryCmd,
  ApproveToolCmd,
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
import { computeMetrics } from "../metrics";
import { actorId, requireActor, requireOperator, type Authenticator } from "../auth";
import type { Access, AppDeps, RunService } from "../context";
import { HttpError, notFound } from "../errors";
import type { Idempotency } from "../idempotency";

const ModelSelection = z.object({ connectionId: z.string().min(1).optional(), agentConnections: z.record(z.string().min(1)).optional() });
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

  // Workspace deletion preserves the immutable security journal for audit.
  for (const kind of ["projects", "runs"] as const) {
    app.post(`/api/${kind}/:id/delete`, async (req, reply) => {
      const actor = await op(req);
      const { id } = IdParam.parse(req.params);
      const cmd = z.object({ commandId: z.string().min(1) }).strict().parse(req.body);
      return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `${kind}.delete:${id}` }, async () => {
        const projectId = kind === "projects" ? id : await d.runs.projectOf(id);
        if (!projectId) throw notFound("run");
        await d.db.transaction(async tx => {
          const [project] = await tx.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, actor.userId), isNull(schema.projects.deletedAt))).for("update");
          if (!project) throw notFound("project");
          const target = kind === "projects" ? eq(schema.runs.projectId, id) : eq(schema.runs.id, id);
          const rows = await tx.select().from(schema.runs).where(and(target, isNull(schema.runs.deletedAt))).for("update");
          if (kind === "runs" && !rows.length) throw notFound("run");
          if (rows.some(run => !["COMPLETED", "RECOVERED", "FAILED", "RECOVERY_FAILED"].includes(run.status))) throw new HttpError("CONFLICT", "Wait for active runs to finish before deleting.");
          const [room] = await tx.select({ id: schema.arenaRooms.id }).from(schema.arenaRooms)
            .innerJoin(schema.workflows, eq(schema.workflows.id, schema.arenaRooms.workflowId))
            .where(and(kind === "projects" ? eq(schema.workflows.projectId, id) : eq(schema.arenaRooms.runId, id), inArray(schema.arenaRooms.status, ["OPEN", "IN_PROGRESS"]))).limit(1);
          if (room) throw new HttpError("CONFLICT", "Finish the active arena session before deleting.");
          const deletedAt = new Date().toISOString();
          await tx.update(schema.runs).set({ deletedAt }).where(and(target, isNull(schema.runs.deletedAt)));
          if (kind === "projects") await tx.update(schema.projects).set({ deletedAt }).where(eq(schema.projects.id, id));
        });
        return { status: 200, body: { deleted: true } };
      });
    });
  }

  app.get("/api/connection", async req => {
    await op(req);
    return { runtime: d.runtimeInfo ?? null, repositoryAvailable: !!d.repositoryConnector, attachments: d.taskAttachments ? { maxBytes: d.taskAttachments.maxBytes } : null };
  });

  app.get("/api/projects/:id/repository", async req => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    await x.access.ownProject(actor, id);
    const [row] = await d.db.select().from(schema.projectConnections).where(eq(schema.projectConnections.projectId, id));
    return { repository: row?.repository ? RepositoryAccess.parse(row.repository) : null };
  });

  app.post("/api/projects/:id/repository", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    await x.access.ownProject(actor, id);
    const cmd = z.object({ commandId: z.string().min(1), selection: RepositorySelection.nullable() }).strict().parse(req.body);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `projects.repository:${id}` }, async () => {
      let repository: RepositoryAccess | null = null;
      if (cmd.selection) {
        if (!d.repositoryConnector) throw new HttpError("UNAVAILABLE", "Repository connections are not enabled on the controller");
        try { repository = await d.repositoryConnector(cmd.selection); }
        catch { throw new HttpError("VALIDATION", "Repository could not be connected. Select a repository root inside the sandbox with tracked regular files within the configured source budget."); }
      }
      await d.db.insert(schema.projectConnections).values({ projectId: id, repository }).onConflictDoUpdate({ target: schema.projectConnections.projectId, set: { repository, updatedAt: new Date().toISOString() } });
      return { status: 200, body: { repository } };
    });
  });

  // Preparation has no tools and persists no workflow. The client submits the validated result
  // through POST /api/workflows before starting its protected run.
  app.post("/api/projects/:id/task-plan", { ...(d.taskAttachments ? { bodyLimit: d.taskAttachments.maxBytes * 6 } : {}) }, async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const cmd = z.object({ commandId: z.string().min(1), instruction: z.string().trim().min(1), baseWorkflowId: z.string().min(1).optional(), baseWorkflowVersion: z.number().int().positive().optional(), contextRunId: z.string().min(1).optional(), connectionId: z.string().min(1).optional(), documents: z.array(TaskDocument).optional() }).strict().parse(req.body);
    await x.access.ownProject(actor, id);
    if (cmd.documents?.length) {
      if (!d.taskAttachments) throw new HttpError("UNAVAILABLE", "Document attachments are not enabled on the controller");
      if (cmd.baseWorkflowId || cmd.contextRunId) throw new HttpError("VALIDATION", "Attach documents to a new task without a saved workflow or follow-up context");
      d.taskAttachments.validate(cmd.documents);
    }
    if (!!cmd.baseWorkflowId !== !!cmd.baseWorkflowVersion) throw new HttpError("VALIDATION", "Select an exact workflow version");
    let base = cmd.baseWorkflowId ? await x.access.ownWorkflow(actor, cmd.baseWorkflowId, cmd.baseWorkflowVersion) : undefined;
    if (base && base.projectId !== id) throw new HttpError("FORBIDDEN", "Workflow belongs to another project");
    let followUp: import("../task-planning").FollowUpContext | undefined;
    if (cmd.contextRunId) {
      const previous = await x.access.operatorRun(actor, cmd.contextRunId);
      if (previous.run.projectId !== id) throw new HttpError("FORBIDDEN", "Run belongs to another project");
      if (!["COMPLETED", "RECOVERED"].includes(previous.run.status) || !previous.verification?.length || previous.verification.some(check => !check.passed)) throw new HttpError("CONFLICT", "Follow up after this run finishes and passes its configured checks");
      if (base && (base.id !== previous.run.workflowId || base.version !== previous.run.workflowVersion)) throw new HttpError("CONFLICT", "Follow-ups retain the original run's workflow boundaries");
      base = await x.access.ownWorkflow(actor, previous.run.workflowId, previous.run.workflowVersion);
      const artifacts = Object.values(previous.artifacts).filter(artifact => previous.latestExecutionByTask[previous.executions[artifact.producerExecutionId]!.taskId] === artifact.producerExecutionId);
      if (artifacts.some(artifact => artifact.trustState !== "CLEAR" || previous.executions[artifact.producerExecutionId]?.securityState !== "CLEAR") || Object.values(previous.sources).some(source => source.securityState !== "CLEAR" && artifacts.some(artifact => artifact.sourceIds.includes(source.id)))) throw new HttpError("CONFLICT", "Previous outputs are no longer usable");
      followUp = { runId: previous.run.id, outputs: artifacts.map(artifact => ({ artifactVersionId: artifact.id, name: artifact.name, preview: artifact.preview })) };
    }
    const [connection] = await d.db.select().from(schema.projectConnections).where(eq(schema.projectConnections.projectId, id));
    const repository = !base && connection?.repository ? RepositoryAccess.parse(connection.repository) : undefined;
    const connectionId = cmd.connectionId ?? await d.providerConnections?.projectDefault(id);
    if (d.providerConnections && !connectionId) throw new HttpError("VALIDATION", "Choose a project model in Connections first");
    const selectedConfig = connectionId ? await d.providerConnections?.config(actor.userId, connectionId) : undefined;
    const planner = d.taskPlanner;
    if (!planner) throw new HttpError("UNAVAILABLE", "Task planning is not connected on the controller");
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `projects.task-plan:${id}` }, async () => {
      const definition = await planner(cmd.instruction, base, repository, followUp, selectedConfig, cmd.documents?.map(document => `Attachment: ${document.name}`));
      if (!cmd.documents?.length) return { status: 200, body: { definition } };
      const stored = await d.taskAttachments!.persist(cmd.documents);
      try { return { status: 200, body: { definition: attachTaskSources(definition, stored.sources) } }; }
      catch (error) { await stored.discard(); throw error; }
    });
  });

  // ── Workflows (definitions are data) ─────────────────────────────────────
  app.post("/api/workflows", async (req, reply) => {
    const actor = await op(req);
    const cmd = CreateWorkflowCmd.parse(req.body);
    await x.access.ownProject(actor, cmd.projectId);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: "workflows.create" }, async () => ({
      status: 201,
      body: d.providerConnections ? await d.providerConnections.saveWorkflow(actor.userId, cmd.projectId, cmd.definition, ModelSelection.parse(req.body)) : await d.workflows.create(cmd.projectId, cmd.definition),
    }));
  });

  app.post("/api/workflows/:id/versions", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const cmd = CreateWorkflowVersionCmd.parse(req.body);
    const previous = await x.access.ownWorkflow(actor, id);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `workflows.version:${id}` }, async () => ({
      status: 201,
      body: d.providerConnections ? await d.providerConnections.saveWorkflow(actor.userId, previous.projectId, cmd.definition, ModelSelection.parse(req.body), previous) : await d.workflows.createVersion(id, cmd.definition),
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

  // Full responses remain operator-only; sockets and event exports retain redacted previews.
  app.get("/api/runs/:id/artifacts/:artifactId/content", async (req, reply) => {
    const actor = await op(req);
    const { id, artifactId } = z.object({ id: z.string().min(1), artifactId: z.string().min(1) }).parse(req.params);
    const snapshot = await x.access.operatorRun(actor, id);
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new HttpError("NOT_FOUND", "Artifact not found in this run");
    if (artifact.trustState !== "CLEAR" || snapshot.executions[artifact.producerExecutionId]?.securityState !== "CLEAR") throw new HttpError("CONFLICT", "This output is no longer usable. Review the incident in Security.");
    return reply.header("Cache-Control", "no-store").send({ content: redactText(await d.broker.content(id, artifactId)) });
  });

  app.get("/api/runs/:id/events", async (req) => {
    const actor = await any(req);
    const { id } = IdParam.parse(req.params);
    const q = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    const snapshot = await x.access.readRun(actor, id);
    return (await d.journal.read(id, q.after ?? 0, q.limit ?? 500)).map(event => publicEvent(event, snapshot));
  });

  app.get("/api/runs/:id/graph", async (req) => {
    const { id } = IdParam.parse(req.params);
    const s = await x.access.readRun(await any(req), id);
    return { ...toGraphView(s), lastSeq: s.lastSeq, graphProjectedUpTo: s.graphProjectedUpTo };
  });

  // ── Evaluation ───────────────────────────────────────────────────────────
  app.get("/api/runs/:id/metrics", async (req) => {
    const { id } = IdParam.parse(req.params);
    const s = await x.access.readRun(await any(req), id);
    return computeMetrics(s, await d.journal.read(id), d.audit);
  });

  app.get("/api/compare", async (req) => {
    const actor = await op(req);
    const q = z.object({ protected: z.string().min(1), baseline: z.string().min(1) }).parse(req.query);
    const [p, b] = await Promise.all([x.access.readRun(actor, q.protected), x.access.readRun(actor, q.baseline)]);
    if (p.run.mode !== "PROTECTED" || b.run.mode !== "BASELINE") throw new HttpError("VALIDATION", "expected one PROTECTED and one BASELINE run");
    const [pm, bm] = await Promise.all([
      computeMetrics(p, await d.journal.read(p.run.id), d.audit),
      computeMetrics(b, await d.journal.read(b.run.id), d.audit),
    ]);
    const key = (h: string[]) => [...h].sort().join(",");
    return {
      protected: pm,
      baseline: bm,
      sameWorkflowVersion: pm.workflowId === bm.workflowId && pm.workflowVersion === bm.workflowVersion,
      sameAttackContent: pm.attackContentHashes.length > 0 && key(pm.attackContentHashes) === key(bm.attackContentHashes),
    };
  });

  /** Full trace + metrics, labelled with the pinned workflow and model config. */
  app.get("/api/runs/:id/export", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const s = await x.access.operatorRun(actor, id);
    const events = await d.journal.read(id);
    const workflow = await d.workflows.getVersion(s.run.workflowId, s.run.workflowVersion);
    const bindings = await d.providerConnections?.bindings(s.run.workflowId, s.run.workflowVersion) ?? {};
    const connections = (await d.providerConnections?.list(actor.userId) ?? []).filter(connection => Object.values(bindings).includes(connection.id));
    reply.header("content-disposition", `attachment; filename="${id}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      run: s.run,
      workflow,
      runtime: Object.keys(bindings).length ? { bindings, connections } : { controllerConfigurationAtExport: d.runtimeInfo ?? null, historicalModelNotRecorded: true },
      metrics: await computeMetrics(s, events, d.audit),
      events,
    };
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

  // ── Tool approvals (REQUIRE_APPROVAL tool calls) ─────────────────────────
  /** Redacted views, from the event-sourced snapshot. */
  app.get("/api/runs/:id/tool-approvals", async (req) => {
    const { id } = IdParam.parse(req.params);
    const s = await x.access.readRun(await any(req), id);
    return Object.values(s.toolApprovals);
  });

  const ownedApproval = async (actor: Awaited<ReturnType<typeof op>>, id: string) => {
    if (!d.toolApprovals) throw new HttpError("UNAVAILABLE", "agent runtime is not connected");
    const runId = await d.toolApprovals.runOf(id);
    if (!runId) throw notFound("tool approval");
    await x.access.operatorRun(actor, runId);
    return d.toolApprovals;
  };

  /** Operator-only: the exact normalized target and arguments being approved. */
  app.get("/api/tool-approvals/:id", async (req) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const view = await (await ownedApproval(actor, id)).privateView(id);
    if (!view) throw notFound("tool approval");
    return view;
  });

  app.post("/api/tool-approvals/:id/resolve", async (req, reply) => {
    const actor = await op(req);
    const { id } = IdParam.parse(req.params);
    const cmd = ApproveToolCmd.parse(req.body);
    const approvals = await ownedApproval(actor, id);
    return x.idem.run(reply, { commandId: cmd.commandId, actorId: actor.userId, route: `tool-approvals.resolve:${id}` }, async () => ({
      status: 200,
      body: await approvals.resolve({ approvalId: id, toolRequestId: cmd.toolRequestId, actionDigest: cmd.actionDigest, decision: cmd.decision, actorId: actor.userId }),
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
