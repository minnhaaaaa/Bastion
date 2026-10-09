import { z } from "zod";
import * as Id from "./ids";
import {
  AgentRole,
  ApprovalStatus,
  Classification,
  PolicyDecision,
  RunStatus,
  SecurityState,
  Severity,
  SourceTrust,
  TaskState,
  ToolOutcome,
  VerificationOutcome,
} from "./enums";
import { Preview, RetryPolicy, Timestamp } from "./entities";

/**
 * Run event journal (ARCHITECTURE §6.1).
 *
 * Rules:
 *  - Persist before broadcast. `seq` is assigned by the journal, gap-free and ordered per run.
 *  - Payloads carry redacted previews / blobRefs only — never raw source content or secrets.
 *  - Arena-private data (attacker identity, cards) never appears in run events.
 */

const envelopeBase = {
  eventId: Id.EventId,
  runId: Id.RunId,
  seq: z.number().int().min(1),
  timestamp: Timestamp,
  traceId: Id.TraceId,
  taskId: Id.TaskId.optional(),
  agentId: Id.AgentId.optional(),
};

const ev = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) =>
  z.object({ ...envelopeBase, type: z.literal(type), payload: z.object(payload) });

// ── Run ────────────────────────────────────────────────────────────────────
export const RunCreated = ev("run.created", {
  projectId: Id.ProjectId,
  workflowId: Id.WorkflowId,
  workflowVersion: z.number().int().min(1),
  mode: z.enum(["PROTECTED", "BASELINE"]),
});
export const RunStatusChanged = ev("run.status_changed", {
  from: RunStatus,
  to: RunStatus,
  reason: z.string().optional(),
});
/** Declares the DAG for the run. Emitted once, right after run.created. */
export const RunPlanned = ev("run.planned", {
  tasks: z.array(
    z.object({
      taskId: Id.TaskId,
      agentId: Id.AgentId,
      role: AgentRole,
      title: z.string(),
      declaredDeps: z.array(Id.TaskId),
      sourceIds: z.array(Id.SourceVersionId),
      retryPolicy: RetryPolicy,
    }),
  ),
});

// ── Task ───────────────────────────────────────────────────────────────────
export const TaskStateChanged = ev("task.state_changed", {
  taskId: Id.TaskId,
  executionId: Id.ExecutionId,
  attempt: z.number().int().min(1),
  from: TaskState,
  to: TaskState,
  reason: z.string().optional(),
});
export const TaskSecurityStateChanged = ev("task.security_state_changed", {
  taskId: Id.TaskId,
  executionId: Id.ExecutionId,
  from: SecurityState,
  to: SecurityState,
  incidentId: Id.IncidentId.optional(),
});

// ── Agent ──────────────────────────────────────────────────────────────────
export const AgentSessionStarted = ev("agent.session_started", {
  agentId: Id.AgentId,
  role: AgentRole,
  executionId: Id.ExecutionId,
  sessionId: z.string(),
});
export const AgentSessionEnded = ev("agent.session_ended", {
  agentId: Id.AgentId,
  executionId: Id.ExecutionId,
  sessionId: z.string(),
  reason: z.enum(["COMPLETED", "STOPPED", "ERROR", "TIMEOUT"]),
});

// ── Source ─────────────────────────────────────────────────────────────────
export const SourceIngested = ev("source.ingested", {
  sourceVersionId: Id.SourceVersionId,
  name: z.string(),
  version: z.number().int().min(1),
  contentHash: z.string(),
  trust: SourceTrust,
  classification: Classification,
  blobRef: z.string(),
  preview: Preview,
});
/** A new version of a source was installed (e.g. by an arena attack card). Never names the actor. */
export const SourceModified = ev("source.modified", {
  sourceVersionId: Id.SourceVersionId,
  previousVersionId: Id.SourceVersionId,
  name: z.string(),
  version: z.number().int().min(1),
  contentHash: z.string(),
  trust: SourceTrust,
  classification: Classification,
  blobRef: z.string(),
  preview: Preview,
});
export const SourceSecurityStateChanged = ev("source.security_state_changed", {
  sourceVersionId: Id.SourceVersionId,
  from: SecurityState,
  to: SecurityState,
  incidentId: Id.IncidentId.optional(),
});

// ── Artifact ───────────────────────────────────────────────────────────────
export const ArtifactPublished = ev("artifact.published", {
  artifactVersionId: Id.ArtifactVersionId,
  name: z.string(),
  version: z.number().int().min(1),
  contentHash: z.string(),
  producerExecutionId: Id.ExecutionId,
  producerTaskId: Id.TaskId,
  sourceIds: z.array(Id.SourceVersionId),
  /** Upstream artifact versions the producer consumed (DERIVED_FROM edges). */
  derivedFrom: z.array(Id.ArtifactVersionId),
  classification: Classification,
  trustState: SecurityState,
  blobRef: z.string(),
  preview: Preview,
});
/** Observed consumption: proves the input was supplied, not that it influenced reasoning. */
export const ArtifactConsumed = ev("artifact.consumed", {
  /** Either an artifact version or a source version. */
  inputVersionId: z.union([Id.ArtifactVersionId, Id.SourceVersionId]),
  consumerExecutionId: Id.ExecutionId,
  consumerTaskId: Id.TaskId,
});
export const ArtifactTrustChanged = ev("artifact.trust_changed", {
  artifactVersionId: Id.ArtifactVersionId,
  from: SecurityState,
  to: SecurityState,
  incidentId: Id.IncidentId.optional(),
});

// ── Tool ───────────────────────────────────────────────────────────────────
export const ToolRequested = ev("tool.requested", {
  toolRequestId: Id.ToolRequestId,
  executionId: Id.ExecutionId,
  agentId: Id.AgentId,
  tool: z.string(),
  operation: z.string(),
  resource: z.string(),
  destination: z.string().nullable(),
  argsHash: z.string(),
});
export const ToolDecided = ev("tool.decided", {
  toolRequestId: Id.ToolRequestId,
  decision: PolicyDecision,
  ruleId: z.string(),
  reason: z.string(),
});
export const ToolExecuted = ev("tool.executed", {
  toolRequestId: Id.ToolRequestId,
  outcome: ToolOutcome,
  /** Redacted result summary. */
  summary: Preview.optional(),
});

// ── Detection (heuristic; never a security guarantee) ──────────────────────
export const AlertSuspiciousContent = ev("alert.suspicious_content", {
  targetId: z.string(),
  detector: z.string(),
  reason: z.string(),
  severity: Severity,
});
export const ClaimUnverified = ev("claim.unverified", {
  artifactVersionId: Id.ArtifactVersionId,
  claim: Preview,
  reason: z.string(),
});

// ── Incident & containment ─────────────────────────────────────────────────
export const IncidentOpened = ev("incident.opened", {
  incidentId: Id.IncidentId,
  sourceVersionId: Id.SourceVersionId,
  severity: Severity,
  reason: z.string(),
  triggerToolRequestId: Id.ToolRequestId.nullable(),
});
export const IncidentQuarantined = ev("incident.quarantined", {
  incidentId: Id.IncidentId,
  sourceVersionId: Id.SourceVersionId,
  /** Authorized human actor (user or arena player id). */
  actorId: z.string(),
});
export const ContainmentApplied = ev("containment.applied", {
  incidentId: Id.IncidentId,
  affectedTaskIds: z.array(Id.TaskId),
  invalidatedArtifactIds: z.array(Id.ArtifactVersionId),
  heldExecutionIds: z.array(Id.ExecutionId),
  /** true if the graph lagged and containment was conservatively widened. */
  widened: z.boolean(),
});

// ── Recovery ───────────────────────────────────────────────────────────────
export const RecoveryPlanned = ev("recovery.planned", {
  incidentId: Id.IncidentId,
  planId: Id.PlanId,
  rerunTaskIds: z.array(Id.TaskId),
  preservedTaskIds: z.array(Id.TaskId),
  replacementSourceVersionId: Id.SourceVersionId,
  planDigest: z.string(),
});
export const ApprovalRequested = ev("approval.requested", {
  approvalId: Id.ApprovalId,
  incidentId: Id.IncidentId,
  planId: Id.PlanId,
  actionDigest: z.string(),
  expiresAt: Timestamp,
});
export const ApprovalResolved = ev("approval.resolved", {
  approvalId: Id.ApprovalId,
  status: ApprovalStatus,
  actorId: z.string(),
});
export const RecoveryStarted = ev("recovery.started", {
  incidentId: Id.IncidentId,
  planId: Id.PlanId,
});
export const VerificationCompleted = ev("verification.completed", {
  incidentId: Id.IncidentId.nullable(),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })),
});
export const RecoveryCompleted = ev("recovery.completed", {
  incidentId: Id.IncidentId,
  planId: Id.PlanId,
  outcome: VerificationOutcome,
});

// ── Infra ──────────────────────────────────────────────────────────────────
/** Emitted by the Neo4j projector after it has applied all events up to `upToSeq`. */
export const GraphProjected = ev("graph.projected", { upToSeq: z.number().int().min(0) });
export const PolicyUnavailable = ev("policy.unavailable", {
  toolRequestId: Id.ToolRequestId.optional(),
  reason: z.string(),
});

export const RunEvent = z.discriminatedUnion("type", [
  RunCreated,
  RunStatusChanged,
  RunPlanned,
  TaskStateChanged,
  TaskSecurityStateChanged,
  AgentSessionStarted,
  AgentSessionEnded,
  SourceIngested,
  SourceModified,
  SourceSecurityStateChanged,
  ArtifactPublished,
  ArtifactConsumed,
  ArtifactTrustChanged,
  ToolRequested,
  ToolDecided,
  ToolExecuted,
  AlertSuspiciousContent,
  ClaimUnverified,
  IncidentOpened,
  IncidentQuarantined,
  ContainmentApplied,
  RecoveryPlanned,
  ApprovalRequested,
  ApprovalResolved,
  RecoveryStarted,
  VerificationCompleted,
  RecoveryCompleted,
  GraphProjected,
  PolicyUnavailable,
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];
export type RunEventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

/** An event before the journal assigns eventId/seq/timestamp. What producers hand to `EventJournal.append`. */
export type NewRunEvent = {
  [K in RunEventType]: Omit<RunEventOf<K>, "eventId" | "seq" | "timestamp">;
}[RunEventType];

export const RUN_EVENT_TYPES = RunEvent.options.map((o) => o.shape.type.value) as RunEventType[];
