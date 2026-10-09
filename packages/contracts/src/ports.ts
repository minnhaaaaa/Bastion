/**
 * Module boundary interfaces. These are where team members' work meets:
 *
 *   Member 2 implements: PolicyEngine, ToolGateway, Scheduler, AgentRuntimeAdapter
 *   Member 3 implements: EventJournal, ArtifactBroker, GraphProjector, RecoveryService
 *
 * Code against these interfaces, not concrete classes. Use in-memory fakes in tests.
 */
import type { NewRunEvent, RunEvent } from "./events";
import type { PolicyRequest, PolicyResult } from "./policy";
import type { ArtifactVersion, RecoveryPlan, SourceVersion, TaskSpec } from "./entities";
import type { Classification, SecurityState } from "./enums";

// ── Event journal (Member 3) ───────────────────────────────────────────────
export interface EventJournal {
  /**
   * Atomically assigns eventId/seq/timestamp and persists. Resolves only after commit;
   * subscribers are notified after commit (persist before broadcast).
   */
  append(runId: string, events: NewRunEvent[]): Promise<RunEvent[]>;
  read(runId: string, afterSeq?: number): Promise<RunEvent[]>;
  /** Called after commit, in seq order. Returns unsubscribe. */
  onCommitted(listener: (event: RunEvent) => void): () => void;
}

// ── Artifact broker (Member 3) ─────────────────────────────────────────────
export type PublishArtifactInput = {
  runId: string;
  name: string;
  producerExecutionId: string;
  producerTaskId: string;
  content: string | Uint8Array;
  classification: Classification;
  traceId: string;
};

export interface ArtifactBroker {
  /** Stores content (blobRef), hashes it, versions it, records PRODUCED/DERIVED_FROM edges. */
  publish(input: PublishArtifactInput): Promise<ArtifactVersion>;
  /**
   * Records a CONSUMED edge and returns content. Throws if the version is not usable
   * (quarantined/invalidated) — the broker is a security boundary, not just storage.
   */
  consume(input: {
    runId: string;
    inputVersionId: string;
    consumerExecutionId: string;
    consumerTaskId: string;
    traceId: string;
  }): Promise<{ content: string | Uint8Array; classification: Classification }>;
  isUsable(versionId: string): Promise<boolean>;
  setTrust(versionId: string, state: SecurityState, incidentId?: string): Promise<void>;
  /** Install a source version (loaded from the workflow source location, or an attack payload). */
  ingestSource(input: {
    runId: string;
    name: string;
    content: string;
    trust: "TRUSTED" | "UNTRUSTED";
    classification: Classification;
    previousVersionId?: string;
    traceId: string;
  }): Promise<SourceVersion>;
  latestUsableSource(runId: string, name: string): Promise<SourceVersion | null>;
}

// ── Policy (Member 2) ──────────────────────────────────────────────────────
export interface PolicyEngine {
  /** Pure & deterministic. Default DENY. Never consults an LLM. */
  evaluate(req: PolicyRequest): PolicyResult;
}

export type ToolCall = {
  runId: string;
  agentId: string;
  executionId: string;
  taskId: string;
  traceId: string;
  tool: string;
  args: Record<string, unknown>;
};

export type ToolCallResult =
  | { status: "EXECUTED"; toolRequestId: string; output: unknown }
  | { status: "DENIED"; toolRequestId: string; ruleId: string; reason: string }
  | { status: "PENDING_APPROVAL"; toolRequestId: string; approvalId: string };

export interface ToolGateway {
  /**
   * normalize → tool.requested → evaluate → tool.decided → (re-authorize, incl. quarantine
   * check of inputs, immediately before) execute → tool.executed. Fails closed on any error.
   */
  dispatch(call: ToolCall): Promise<ToolCallResult>;
}

// ── Scheduler / orchestrator (Member 2) ────────────────────────────────────
export interface Scheduler {
  /** Emits run.planned, then drives tasks to completion as inputs become usable. */
  start(runId: string, tasks: TaskSpec[]): Promise<void>;
  /** Stop scheduling these tasks and pause/cancel active executions at a safe boundary. */
  hold(runId: string, taskIds: string[], reason: string): Promise<{ heldExecutionIds: string[] }>;
  /** New attempts (fresh executionIds) in the given topological order. */
  rerun(runId: string, taskIds: string[], replacementSourceVersionId: string): Promise<void>;
  onTaskSettled(listener: (e: { runId: string; taskId: string; executionId: string; ok: boolean }) => void): () => void;
}

// ── Agent runtime (Member 2) — ARCHITECTURE §4.1 ───────────────────────────
export type AgentRunRequest = {
  runId: string;
  taskId: string;
  agentId: string;
  inputArtifactIds: string[];
  capabilities: string[];
  workspaceId: string;
};

export type RuntimeEvent =
  | { kind: "turn"; text: string }
  | { kind: "tool_proposed"; tool: string; args: Record<string, unknown> }
  | { kind: "output"; name: string; content: string }
  | { kind: "finished"; ok: boolean; error?: string };

export interface AgentRuntimeAdapter {
  startTask(req: AgentRunRequest): Promise<{ sessionId: string }>;
  requestStop(sessionId: string): Promise<void>;
  subscribe(sessionId: string, sink: (event: RuntimeEvent) => void): () => void;
}

// ── Knowledge graph (Member 3) ─────────────────────────────────────────────
export interface GraphProjector {
  /** Idempotent (keyed on eventId). Safe to replay the whole journal. */
  apply(event: RunEvent): Promise<void>;
  /** Conservative transitive impact set over vetted relations, filtered by runId. */
  impactSet(runId: string, sourceVersionId: string): Promise<{ taskIds: string[]; artifactIds: string[] }>;
  /** Highest seq applied for this run. Containment must not trust impactSet if this lags. */
  projectedUpTo(runId: string): Promise<number>;
}

// ── Recovery (Member 3) ────────────────────────────────────────────────────
export interface RecoveryService {
  /** Synchronous in Postgres: quarantine source, hold + invalidate descendants. */
  quarantine(incidentId: string, sourceVersionId: string, actorId: string): Promise<void>;
  plan(incidentId: string, replacementSourceVersionId: string): Promise<RecoveryPlan>;
  /** Validates single-use, unexpired approval bound to the plan digest; then reruns + verifies. */
  approveAndRecover(input: { approvalId: string; planId: string; actionDigest: string; actorId: string }): Promise<void>;
}

// ── Workflow registry (Member 3) ───────────────────────────────────────────
// Workflow definitions are data submitted via POST /api/workflows and stored in Postgres.
export interface WorkflowRepository {
  create(projectId: string, definition: import("./workflow").WorkflowDefinition): Promise<import("./workflow").Workflow>;
  get(workflowId: string): Promise<import("./workflow").Workflow | null>;
  list(projectId: string): Promise<import("./workflow").Workflow[]>;
}
