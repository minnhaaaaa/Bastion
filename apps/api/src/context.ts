import { and, eq, count, notInArray } from "drizzle-orm";
import {
  newId,
  type GraphProjector,
  type RunLauncher,
  type RunSnapshot,
  type TargetAudit,
  type Workflow,
} from "@bastion/contracts";
import {
  CommandStore,
  PgEventJournal,
  PgWorkflowRepository,
  ProjectRepository,
  RunRepository,
  schema,
  type Db,
} from "@bastion/db";
import type { PgArtifactBroker } from "@bastion/provenance";
import type { RecoveryManager } from "@bastion/recovery";
import type { ToolApprovalCoordinator } from "./toolApprovals";
import type { FastifyBaseLogger } from "fastify";
import type { Actor } from "./auth";
import { HttpError, forbidden, notFound } from "./errors";
import { publicSnapshot } from "./public-view";

/** Everything the HTTP/socket layer needs. Built by the composition root (index.ts) or tests. */
export interface AppDeps {
  /** Baseline is available only to explicitly isolated test launchers. Production omits it. */
  baselineEnabled?: boolean;
  providerConnections?: import("./provider-connections").ProviderConnections;
  chatgptAuth?: import("./chatgpt-auth").ChatGPTAuth;
  repositoryConnector?: import("./repository-access").RepositoryConnector;
  taskAttachments?: import("./task-attachments").TaskAttachmentStore;
  taskPlanner?: import("./task-planning").TaskPlanner;
  db: Db;
  journal: PgEventJournal;
  broker: PgArtifactBroker;
  recovery: RecoveryManager;
  projects: ProjectRepository;
  workflows: PgWorkflowRepository;
  runs: RunRepository;
  commands: CommandStore;
  /** Member 2 runtime. Absent until wired: runs/rooms cannot start (503), reads still work. */
  launcher?: RunLauncher;
  audit?: TargetAudit;
  /** Tool-call approvals (present when the runtime is enabled). */
  toolApprovals?: ToolApprovalCoordinator;
  graph?: GraphProjector;
  operators: Map<string, string>;
  /** Model/runtime configuration recorded in exports (never credentials). */
  runtimeInfo?: { provider: string; model: string; timeoutMs: number };
  config: {
    security: import("./security-config").ApiSecurity;
    roomTtlMs: number;
    briefingMs: number;
    attackWindowMs: number;
    /** Offline time before a defender's control cards move to a connected defender. */
    reconnectGraceMs: number;
    /** How often expired rooms are swept. */
    sweepIntervalMs: number;
    joinRatePerMinute: number;
    actionRatePerMinute: number;
  };
  now?: () => Date;
}

/** Ownership / membership checks shared by routes and sockets. */
export class Access {
  constructor(private readonly d: AppDeps) {}

  async ownProject(actor: Actor, projectId: string) {
    const p = await this.d.projects.get(projectId);
    if (!p) throw notFound("project");
    if (actor.kind !== "operator" || p.ownerId !== actor.userId) throw forbidden("not your project");
    return p;
  }

  async ownWorkflow(actor: Actor, workflowId: string, version?: number): Promise<Workflow> {
    const wf = version ? await this.d.workflows.getVersion(workflowId, version) : await this.d.workflows.get(workflowId);
    if (!wf) throw notFound("workflow");
    await this.ownProject(actor, wf.projectId);
    return wf;
  }

  /** Operators who own the run's project, or host/players of a room bound to the run. */
  async canReadRun(actor: Actor, runId: string): Promise<boolean> {
    const projectId = await this.d.runs.projectOf(runId);
    if (!projectId) return false;
    if (actor.kind === "operator") return (await this.d.projects.get(projectId))?.ownerId === actor.userId;
    const [room] = await this.d.db.select().from(schema.arenaRooms).where(eq(schema.arenaRooms.id, actor.roomId));
    return room?.runId === runId && room.status !== "EXPIRED" && Date.parse(room.expiresAt) > (this.d.now?.() ?? new Date()).getTime();
  }

  async readRun(actor: Actor, runId: string): Promise<RunSnapshot> {
    if (!(await this.canReadRun(actor, runId))) throw notFound("run");
    const s = await this.d.journal.snapshot(runId);
    if (!s) throw notFound("run");
    return publicSnapshot(s);
  }

  async operatorRun(actor: Actor, runId: string): Promise<RunSnapshot> {
    if (actor.kind !== "operator") throw forbidden("operator token required");
    return this.readRun(actor, runId);
  }

  async operatorIncident(actor: Actor, incidentId: string) {
    const runId = await this.d.runs.runOfIncident(incidentId);
    if (!runId) throw notFound("incident");
    const s = await this.operatorRun(actor, runId);
    return { runId, s, incident: s.incidents[incidentId]! };
  }
}

/** Starts runs: run.created is committed by the API; the runtime (Member 2) does the rest. */
export class RunService {
  private readonly starts = new Map<string, Promise<unknown>>();
  constructor(
    private readonly d: AppDeps,
    private readonly log: FastifyBaseLogger,
  ) {}

  assertRuntime(): RunLauncher {
    if (!this.d.launcher) throw new HttpError("UNAVAILABLE", "agent runtime is not connected; runs cannot start");
    return this.d.launcher;
  }

  async start(workflow: Workflow, mode: "PROTECTED" | "BASELINE", attackPayloadIds: string[]): Promise<string> {
    const project = await this.d.projects.get(workflow.projectId);
    if (!project) throw notFound("project");
    const key = project.ownerId;
    const previous = this.starts.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.startUnlocked(workflow, mode, attackPayloadIds, key));
    this.starts.set(key, pending);
    try { return await pending; }
    finally { if (this.starts.get(key) === pending) this.starts.delete(key); }
  }

  private async startUnlocked(workflow: Workflow, mode: "PROTECTED" | "BASELINE", attackPayloadIds: string[], ownerId: string): Promise<string> {
    if (mode === "BASELINE" && !this.d.baselineEnabled) throw forbidden("Baseline execution requires an isolated test launcher; it is disabled on this controller");
    const definition = workflow.definition;
    const budget = this.d.config.security;
    const [active] = await this.d.db.select({ total: count() }).from(schema.runs)
      .innerJoin(schema.projects, eq(schema.runs.projectId, schema.projects.id)).where(and(eq(schema.projects.ownerId, ownerId), notInArray(schema.runs.status, ["COMPLETED", "RECOVERED", "FAILED", "RECOVERY_FAILED"])));
    if (active!.total >= budget.maxActiveRunsPerOwner) throw new HttpError("RATE_LIMITED", "Active run quota reached; complete existing runs before starting more");
    if (definition.tasks.length > budget.maxWorkflowTasks || definition.sources.length > budget.maxWorkflowSources || definition.policyRules.length > budget.maxWorkflowRules) throw new HttpError("VALIDATION", "Workflow exceeds controller complexity limits");
    const launcher = this.assertRuntime();
    if (!this.d.providerConnections) {
      const [assigned] = await this.d.db.select().from(schema.workflowModels).where(and(eq(schema.workflowModels.workflowId, workflow.id), eq(schema.workflowModels.version, workflow.version)));
      if (assigned && Object.keys(assigned.bindings).length) throw new HttpError("UNAVAILABLE", "Restore provider connection storage before running this workflow");
    }
    if (this.d.providerConnections) {
      const project = await this.d.projects.get(workflow.projectId);
      if (!project) throw notFound("project");
      await this.d.providerConnections.validateBindings(project.ownerId, workflow.definition, await this.d.providerConnections.bindings(workflow.id, workflow.version));
    }
    const runId = newId("run");
    const traceId = newId("trace");
    await this.d.journal.append(runId, [
      {
        runId,
        traceId,
        type: "run.created",
        payload: { projectId: workflow.projectId, workflowId: workflow.id, workflowVersion: workflow.version, mode },
      },
    ]);
    // Launch runs in the background; failures are recorded as events, never swallowed.
    void launcher.launch({ runId, workflow, attackPayloadIds, traceId }).catch(async (err) => {
      this.log.error({ err, runId }, "run launch failed");
      const s = await this.d.journal.snapshot(runId);
      if (s && s.run.status !== "FAILED")
        await this.d.journal.append(runId, [
          { runId, traceId, type: "run.status_changed", payload: { from: s.run.status, to: "FAILED", reason: "Run launch failed; inspect the private controller logs" } },
        ]);
    });
    return runId;
  }
}
