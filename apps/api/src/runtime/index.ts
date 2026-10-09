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
import type { PgEventJournal, PgWorkflowRepository } from "@bastion/db";
import type { PgArtifactBroker } from "@bastion/provenance";
import { WorkflowScheduler, schedulerParallelismFromEnv, type ExecutionContext } from "@bastion/orchestrator";
import { ExecutionFence } from "@bastion/runtime-adapter";
import { piConfigFromEnv, piRuntimeForExecution, type GatewayTool } from "@bastion/runtime-pi";
import { PolicyToolGateway, SandboxClient, WorkflowPolicyEngine, sandboxConfigFromEnv } from "@bastion/security";
import { WorkflowRunner } from "@bastion/scenario-kit";
import { sandboxLoader } from "./loader";
import { gatewayToolsFor } from "./tools";
import { SandboxTargetAudit, verifyRun } from "./verification";

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
  const sandbox = sandboxConfigFromEnv(env);
  const parallelism = schedulerParallelismFromEnv(env);
  const httpOrigins = JSON.parse(required(env, "SANDBOX_HTTP_ORIGINS")) as string[];
  const maxBytes = Number(required(env, "SANDBOX_MAX_BYTES"));
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

  const gateway = new PolicyToolGateway({
    journal,
    broker,
    normalize: (call) => client.normalize(call),
    execute: (call, req) => client.execute(call, req),
    withExecutionFence: (call, dispatch) => fence.run(call.executionId, dispatch),
    // Authoritative execution context from the journal — never from the model or the caller.
    async context(call) {
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
    },
  });

  const scheduler = new WorkflowScheduler({
    journal,
    broker,
    parallelism,
    workflowForRun: definitionFor,
    workspaceForRun: async () => sandbox.workerRoot,
    withExecutionFence: (id, op) => fence.run(id, op),
    runtime: async (context) =>
      input.createAgent ? input.createAgent(context, gateway, tools) : piRuntimeForExecution({ context, cwd: sandbox.hostRoot, config: pi, tools, gateway }),
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
    verify: (s) => verifyRun(s, audit),
  });

  const launcher: RunLauncher = {
    async launch({ runId, attackPayloadIds }) {
      await runner.prepare(runId);
      for (const id of attackPayloadIds) await runner.applyAttack(runId, id);
      await runner.start(runId);
    },
  };

  const verifier: RecoveryVerifier = { verify: async (runId) => verifyRun(await snapshot(runId), audit) };

  return { launcher, scheduler, verifier, audit, fence };
}
