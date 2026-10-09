import { z } from "zod";
import * as Id from "./ids";
import {
  ApprovalRequest,
  ArtifactVersion,
  DependencyEdge,
  RecoveryPlan,
  Run,
  SecurityIncident,
  SourceVersion,
  TaskExecution,
  TaskSpec,
  ToolRequest,
} from "./entities";
import { GraphNodeLabel, GraphRelType, SecurityState, TaskState, PolicyDecision } from "./enums";

/**
 * Authoritative run state as derived from the event journal by `applyEvent`.
 * Maps keyed by id keep the reducer simple and the JSON stable.
 * Sent as `run.snapshot` on subscribe/reconnect and returned by GET /api/runs/:id.
 */
export const RunSnapshot = z.object({
  run: Run,
  tasks: z.record(TaskSpec),
  /** All execution attempts, keyed by executionId. */
  executions: z.record(TaskExecution),
  /** taskId → executionId of the latest attempt. */
  latestExecutionByTask: z.record(z.string()),
  sources: z.record(SourceVersion),
  artifacts: z.record(ArtifactVersion),
  edges: z.array(DependencyEdge),
  toolRequests: z.record(ToolRequest),
  incidents: z.record(SecurityIncident),
  plans: z.record(RecoveryPlan),
  approvals: z.record(ApprovalRequest),
  alerts: z.array(z.object({ seq: z.number(), targetId: z.string(), detector: z.string(), reason: z.string() })),
  verification: z
    .array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() }))
    .nullable(),
  graphProjectedUpTo: z.number().int(),
  lastSeq: z.number().int(),
});
export type RunSnapshot = z.infer<typeof RunSnapshot>;

/** View model for React Flow. Layout (x/y) is the UI's job. */
export const GraphViewNode = z.object({
  id: z.string(),
  label: GraphNodeLabel,
  title: z.string(),
  taskState: TaskState.optional(),
  securityState: SecurityState.optional(),
  decision: PolicyDecision.optional(),
  /** Execution attempt, so the UI can highlight reruns. */
  attempt: z.number().optional(),
});
export type GraphViewNode = z.infer<typeof GraphViewNode>;

export const GraphViewEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  relation: GraphRelType,
});
export type GraphViewEdge = z.infer<typeof GraphViewEdge>;

export const GraphView = z.object({ nodes: z.array(GraphViewNode), edges: z.array(GraphViewEdge) });
export type GraphView = z.infer<typeof GraphView>;

export const RunSummary = z.object({
  id: Id.RunId,
  workflowId: z.string(),
  mode: z.enum(["PROTECTED", "BASELINE"]),
  status: Run.shape.status,
  startedAt: z.string().nullable(),
  openIncidents: z.number().int(),
});
export type RunSummary = z.infer<typeof RunSummary>;
