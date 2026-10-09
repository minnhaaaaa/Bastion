import { z } from "zod";
import * as Id from "./ids";
import {
  AgentRole,
  ApprovalStatus,
  ArenaPhase,
  ArenaRole,
  Classification,
  GraphRelType,
  IncidentState,
  PolicyDecision,
  RoomStatus,
  RunStatus,
  SecurityState,
  Severity,
  SourceTrust,
  TaskState,
  ToolOutcome,
  ActionOutcome,
} from "./enums";

/** ISO-8601 timestamp string. All times are server clock. */
export const Timestamp = z.string().datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** Short, redacted, safe-to-broadcast preview. Full content lives behind a blobRef. */
export const Preview = z.string().max(280);

export const Project = z.object({
  id: Id.ProjectId,
  ownerId: Id.UserId,
  name: z.string(),
  policySetId: z.string(),
});
export type Project = z.infer<typeof Project>;

export const AgentSpec = z.object({
  id: Id.AgentId,
  projectId: Id.ProjectId,
  role: AgentRole,
  /** Capability strings, see policy.ts `Capability`. */
  capabilityProfile: z.array(z.string()),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

export const Run = z.object({
  id: Id.RunId,
  projectId: Id.ProjectId,
  workflowId: Id.WorkflowId,
  workflowVersion: z.number().int().min(1),
  /** Protected runs go through the policy gate; baseline runs are the labeled vulnerable comparison. */
  mode: z.enum(["PROTECTED", "BASELINE"]),
  status: RunStatus,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type Run = z.infer<typeof Run>;

export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1),
  idempotent: z.boolean(),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const TaskSpec = z.object({
  id: Id.TaskId,
  runId: Id.RunId,
  role: AgentRole,
  agentId: Id.AgentId,
  title: z.string(),
  /** Upstream tasks whose output artifacts this task needs. */
  declaredDeps: z.array(Id.TaskId),
  /** Source documents read directly by this task. */
  sourceIds: z.array(Id.SourceVersionId),
  retryPolicy: RetryPolicy,
});
export type TaskSpec = z.infer<typeof TaskSpec>;

export const TaskExecution = z.object({
  id: Id.ExecutionId,
  taskId: Id.TaskId,
  attempt: z.number().int().min(1),
  state: TaskState,
  securityState: SecurityState,
  sessionId: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type TaskExecution = z.infer<typeof TaskExecution>;

export const SourceVersion = z.object({
  id: Id.SourceVersionId,
  runId: Id.RunId,
  /** Stable logical name, e.g. "docs/api-guide.md"; several versions share it. */
  name: z.string(),
  version: z.number().int().min(1),
  contentHash: z.string(),
  trust: SourceTrust,
  securityState: SecurityState,
  classification: Classification,
  blobRef: z.string(),
  preview: Preview,
});
export type SourceVersion = z.infer<typeof SourceVersion>;

export const ArtifactVersion = z.object({
  id: Id.ArtifactVersionId,
  runId: Id.RunId,
  /** Stable logical name, e.g. "research-notes"; several versions share it. */
  name: z.string(),
  version: z.number().int().min(1),
  contentHash: z.string(),
  /** Source versions this artifact was (observably) derived from. */
  sourceIds: z.array(Id.SourceVersionId),
  producerExecutionId: Id.ExecutionId,
  classification: Classification,
  trustState: SecurityState,
  blobRef: z.string(),
  preview: Preview,
});
export type ArtifactVersion = z.infer<typeof ArtifactVersion>;

/** Authoritative observed edge in Postgres; replay source for the Neo4j projection. */
export const DependencyEdge = z.object({
  id: Id.EdgeId,
  runId: Id.RunId,
  fromType: z.string(),
  fromId: z.string(),
  toType: z.string(),
  toId: z.string(),
  relation: GraphRelType,
  sourceEventId: Id.EventId,
});
export type DependencyEdge = z.infer<typeof DependencyEdge>;

export const ToolRequest = z.object({
  id: Id.ToolRequestId,
  runId: Id.RunId,
  executionId: Id.ExecutionId,
  agentId: Id.AgentId,
  toolName: z.string(),
  operation: z.string(),
  resource: z.string(),
  destination: z.string().nullable(),
  argsHash: z.string(),
  decision: PolicyDecision.nullable(),
  policyRuleId: z.string().nullable(),
  reason: z.string().nullable(),
  executionOutcome: ToolOutcome.nullable(),
});
export type ToolRequest = z.infer<typeof ToolRequest>;

export const SecurityIncident = z.object({
  id: Id.IncidentId,
  runId: Id.RunId,
  sourceVersionId: Id.SourceVersionId,
  severity: Severity,
  state: IncidentState,
  reason: z.string(),
  triggerToolRequestId: Id.ToolRequestId.nullable(),
});
export type SecurityIncident = z.infer<typeof SecurityIncident>;

export const RecoveryPlan = z.object({
  id: Id.PlanId,
  incidentId: Id.IncidentId,
  /** Topologically ordered. */
  rerunTaskIds: z.array(Id.TaskId),
  preservedTaskIds: z.array(Id.TaskId),
  replacementSourceVersionId: Id.SourceVersionId,
  /** sha256 over the canonical plan; approvals bind to this exact digest. */
  planDigest: z.string(),
});
export type RecoveryPlan = z.infer<typeof RecoveryPlan>;

export const ApprovalRequest = z.object({
  id: Id.ApprovalId,
  incidentId: Id.IncidentId,
  planId: Id.PlanId,
  /** Who resolved it (null while pending). Never an agent. */
  actorId: z.string().nullable(),
  actionDigest: z.string(),
  expiresAt: Timestamp,
  status: ApprovalStatus,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ArenaRoom = z.object({
  id: Id.RoomId,
  runId: Id.RunId.nullable(),
  status: RoomStatus,
  phase: ArenaPhase,
  hostId: z.string(),
});
export type ArenaRoom = z.infer<typeof ArenaRoom>;

export const ArenaPlayer = z.object({
  id: Id.PlayerId,
  roomId: Id.RoomId,
  sessionId: z.string(),
  /** Private. Only ever sent to that player (and to everyone after REVEAL). */
  role: ArenaRole,
  displayAlias: z.string().max(24),
  connected: z.boolean(),
});
export type ArenaPlayer = z.infer<typeof ArenaPlayer>;

export const ArenaAction = z.object({
  id: z.string(),
  roomId: Id.RoomId,
  playerId: Id.PlayerId,
  commandId: Id.CommandId,
  type: z.string(),
  outcome: ActionOutcome,
});
export type ArenaAction = z.infer<typeof ArenaAction>;
