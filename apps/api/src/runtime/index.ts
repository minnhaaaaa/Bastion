import { injectionFindingRecorder } from "./injection-findings";
import { taskAttachmentStore } from "../task-attachments";
import { ProviderConnections } from "../provider-connections";
import { and, eq } from "drizzle-orm";
import { schema } from "@bastion/db";
import { repositoryConnector } from "../repository-access";
import { createTaskPlanner } from "../task-planning";
import { join, relative } from "node:path";
import {
  WorkflowDefinition,
  type Classification,
  type RecoveryVerifier,
  type RunLauncher,
  type AgentRuntimeAdapter,
  type RunSnapshot,
  type TargetAudit,
  type ToolGateway,
} from "@bastion/contracts";
import { ProjectRepository, RunRepository, type Db, type PgEventJournal, type PgWorkflowRepository } from "@bastion/db";
import type { PgArtifactBroker } from "@bastion/provenance";
import { WorkflowScheduler, schedulerParallelismFromEnv, type ExecutionContext } from "@bastion/orchestrator";
import { ExecutionFence } from "@bastion/runtime-adapter";
import { piConfigFromEnv, piModelRegistry, piRuntimeForExecution, type GatewayTool } from "@bastion/runtime-pi";
import { PolicyToolGateway, SandboxClient, ToolApprovalService, WorkflowPolicyEngine, sandboxConfigFromEnv, type DispatchContext } from "@bastion/security";
import { PgToolApprovalStore, ToolApprovalCoordinator } from "../toolApprovals";
import { WorkflowRunner } from "@bastion/scenario-kit";
import { sandboxLoader } from "./loader";
import { gatewayToolsFor } from "./tools";
import { SandboxTargetAudit, verifyRun } from "./verification";
import { executeToolChecks } from "./tool-checks";

const RANK: Record<Classification, number> = { PUBLIC: 0, INTERNAL: 1, SYNTHETIC_SECRET: 2 };

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v?.trim()) throw new Error(`Missing ${key}`);
  return v;
}

/**
 * Composes Member 2's runtime (Pi + gateway + sandbox + scheduler + runner) with Member 3's
 * journal and broker. All settings come from the environment via each package's *FromEnv.
 */
export function buildAgentRuntime(input: {
  env: NodeJS.ProcessEnv;
  db: Db;
  journal: PgEventJournal;
  broker: PgArtifactBroker;
  workflows: PgWorkflowRepository;
  /**
   * Agent factory. Production always uses Pi (the default). Automated tests may pass a scripted
   * agent to exercise the real gateway/sandbox/scheduler path without a model provider.
   */
  createAgent?: (context: ExecutionContext, gateway: ToolGateway, tools: GatewayTool[]) => AgentRuntimeAdapter;
}) {
  const { env, journal, broker, workflows } = input;
  const pi = piConfigFromEnv(env);
  if (!input.createAgent) piModelRegistry(pi);
  const providerConnections = env.PROVIDER_CREDENTIAL_KEY ? new ProviderConnections(input.db, pi, env.PROVIDER_CREDENTIAL_KEY) : undefined;
  const sandbox = sandboxConfigFromEnv(env);
  const parallelism = schedulerParallelismFromEnv(env);
  const httpOrigins = JSON.parse(required(env, "SANDBOX_HTTP_ORIGINS")) as string[];
  const maxBytes = Number(required(env, "SANDBOX_MAX_BYTES"));
  const approvalTtlMs = Number(required(env, "TOOL_APPROVAL_TTL_SECONDS")) * 1000;
  if (!Number.isSafeInteger(approvalTtlMs) || approvalTtlMs <= 0) throw new Error("Invalid TOOL_APPROVAL_TTL_SECONDS");
  // Host-side path of the worker's audit file (audit dir is mounted at SANDBOX_AUDIT_MOUNT in the worker).
  const auditFile = join(required(env, "SANDBOX_AUDIT_DIRECTORY"), relative(required(env, "SANDBOX_AUDIT_MOUNT"), required(env, "SANDBOX_AUDIT_PATH")));

  const fence = new ExecutionFence();
  const client = new SandboxClient(sandbox);
  const tools = gatewayToolsFor(sandbox.toolOperations);

  const snapshot = async (runId: string): Promise<RunSnapshot> => {
    const s = await journal.snapshot(runId);
    if (!s) throw new Error("Unknown run");
    return s;
  };
  const pinned = new Map<string, WorkflowDefinition>();
  const definitionFor = async (runId: string): Promise<WorkflowDefinition> => {
    const cached = pinned.get(runId);
    if (cached) return cached;
    const { run } = await snapshot(runId);
    const wf = await workflows.getVersion(run.workflowId, run.workflowVersion);
    if (!wf) throw new Error("Pinned workflow version unavailable");
    const def = WorkflowDefinition.parse(wf.definition);
    pinned.set(runId, def);
    return def;
  };

  // Authoritative execution context from the journal — never from the model or the caller.
  const context = async (call: Parameters<ToolGateway["dispatch"]>[0]): Promise<DispatchContext> => {
    const s = await snapshot(call.runId);
    const ex = s.executions[call.executionId];
    const task = ex ? s.tasks[ex.taskId] : undefined;
    if (!ex || !task || ex.taskId !== call.taskId || task.agentId !== call.agentId) throw new Error("Tool call identity does not match a scheduled execution");
    const inputVersionIds = s.edges.filter((e) => e.relation === "CONSUMED" && e.toId === ex.id).map((e) => e.fromId);
    const inputClassification = inputVersionIds
      .map((id) => (s.sources[id] ?? s.artifacts[id])!.classification)
      .reduce<Classification>((a, b) => (RANK[b] > RANK[a] ? b : a), "PUBLIC");
    return {
      policy: new WorkflowPolicyEngine(await definitionFor(call.runId)),
      inputClassification,
      inputVersionIds,
      active: ex.state === "RUNNING",
      mode: s.run.mode,
    };
  };

  // Tool approvals (CONTRACT_PROPOSAL B3): durable store, executor, and the waiter agents block on.
  const projects = new ProjectRepository(input.db);
  const runs = new RunRepository(input.db);
  const approvalStore = new PgToolApprovalStore(input.db, journal);
  const approvalService = new ToolApprovalService({
    store: approvalStore,
    journal,
    broker,
    ttlMs: approvalTtlMs,
    now: () => new Date(),
    // Only the authenticated operator who owns the run's project — never an agent or arena player.
    authorizeHuman: async (actorId, runId) => {
      if (!actorId.startsWith("user_")) return false;
      const projectId = await runs.projectOf(runId);
      return projectId !== null && (await projects.get(projectId))?.ownerId === actorId;
    },
    pinnedWorkflow: async (runId) => {
      const { run } = await snapshot(runId);
      return { id: run.workflowId, version: run.workflowVersion };
    },
    context,
    normalize: (call) => client.normalize(call),
    execute: (call, req) => client.execute(call, req),
    withExecutionFence: (call, op) => fence.run(call.executionId, op),
  });

  const policyGateway = new PolicyToolGateway({
    journal,
    broker,
    context,
    normalize: (call) => client.normalize(call),
    execute: (call, req) => client.execute(call, req),
    approvals: approvalService,
    withExecutionFence: (call, dispatch) => fence.run(call.executionId, dispatch),
  });
  const toolApprovals = new ToolApprovalCoordinator(approvalStore, approvalService, journal);
  // Agents get the waiting gateway: an approval-gated call blocks until a human resolves it.
  const gateway = toolApprovals.wrap(policyGateway);

  const reportFinding = injectionFindingRecorder(journal, (runId, versionId) => broker.content(runId, versionId));
  const scheduler = new WorkflowScheduler({
    journal,
    broker,
    parallelism,
    workflowForRun: definitionFor,
    workspaceForRun: async () => sandbox.workerRoot,
    withExecutionFence: (id, op) => fence.run(id, op),
    verifyExecution: async context => executeToolChecks(context, (await definitionFor(context.runId)).acceptanceChecks?.filter(check => check.kind === "TOOL").filter(check => check.taskId === context.task.id) ?? [], gateway, journal),
    runtime: async (context) => {
      const evidence = await snapshot(context.runId);
      const inputs = context.inputs.map((value, index) => {
        const versionId = context.inputVersionIds[index]!;
        const source = evidence.sources[versionId];
        const artifact = evidence.artifacts[versionId];
        if (!source && !artifact) throw new Error("Input version is missing from provenance");
        return { ...value, versionId, name: (source ?? artifact)!.name,
          kind: source ? "source" as const : "artifact" as const,
          ...(source ? { declaredTrust: source.trust } : {}),
          securityState: source?.securityState ?? artifact!.trustState };
      });
      const enriched = { ...context, inputs };
      const workflow = await workflows.getVersion(evidence.run.workflowId, evidence.run.workflowVersion);
      if (!workflow) throw new Error("Pinned workflow version unavailable");
      if (!providerConnections) {
        const [assigned] = await input.db.select().from(schema.workflowModels).where(and(eq(schema.workflowModels.workflowId, workflow.id), eq(schema.workflowModels.version, workflow.version)));
        if (assigned && Object.keys(assigned.bindings).length) throw new Error("Provider connection storage is required for this workflow");
      }
      const config = providerConnections ? await providerConnections.forExecution(workflow, context.task.agentId) : pi;
      return input.createAgent ? input.createAgent(enriched, gateway, tools) : piRuntimeForExecution({ context: enriched, cwd: sandbox.hostRoot, config, tools, gateway, reportFinding: reportFinding({ runId: context.runId, executionId: context.executionId, traceId: context.traceId, taskId: context.task.id, agentId: context.task.agentId, inputVersionIds: context.inputVersionIds }) });
    },
  });

  const audit: TargetAudit = new SandboxTargetAudit(auditFile, snapshot, definitionFor);

  const runner = new WorkflowRunner({
    workflows,
    broker,
    journal,
    load: sandboxLoader({ hostRoot: sandbox.hostRoot, workerRoot: sandbox.workerRoot, httpOrigins, timeoutMs: sandbox.timeoutMs, maxBytes }),
    run: async (runId) => (await snapshot(runId)).run,
    // One scheduler for both modes: the gateway reads the run's persisted mode per call.
    scheduler: () => scheduler,
    snapshot,
    verify: async (s) => verifyRun(s, audit, { definition: await definitionFor(s.run.id), journal, content: (r, v) => broker.content(r, v) }),
  });

  const launcher: RunLauncher = {
    async launch({ runId, attackPayloadIds }) {
      await runner.prepare(runId);
      for (const id of attackPayloadIds) await runner.applyAttack(runId, id);
      await runner.start(runId);
    },
  };

  const verifier: RecoveryVerifier = {
    verify: async (runId) => verifyRun(await snapshot(runId), audit, { definition: await definitionFor(runId), journal, content: (r, v) => broker.content(r, v) }),
  };

  return { taskAttachments: taskAttachmentStore({ hostRoot: sandbox.hostRoot, workerRoot: sandbox.workerRoot, maxBytes }), providerConnections, repositoryConnector: env.REPOSITORY_GIT_EXECUTABLE ? repositoryConnector({ hostRoot: sandbox.hostRoot, workerRoot: sandbox.workerRoot, gitExecutable: env.REPOSITORY_GIT_EXECUTABLE, timeoutMs: sandbox.timeoutMs, maxBytes, toolOperations: sandbox.toolOperations }) : undefined, taskPlanner: createTaskPlanner(pi, sandbox.hostRoot), launcher, scheduler, verifier, audit, fence, gateway, toolApprovals, info: { provider: pi.provider, model: pi.model, timeoutMs: pi.timeoutMs } };
}
