import { z } from "zod";

/**
 * All IDs are server-generated, prefixed strings. The prefix makes logs and
 * graph nodes self-describing and lets Zod reject an ID of the wrong kind.
 */
export const ID_PREFIXES = {
  run: "run_",
  task: "task_",
  exec: "exec_",
  agent: "agent_",
  source: "src_",
  artifact: "art_",
  tool: "tool_",
  incident: "inc_",
  approval: "appr_",
  /** Tool-call approvals; distinct from recovery approvals (appr_). */
  toolApproval: "tapr_",
  plan: "plan_",
  room: "room_",
  player: "player_",
  command: "cmd_",
  trace: "trace_",
  event: "evt_",
  edge: "edge_",
  workflow: "wf_",
  project: "proj_",
  user: "user_",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const idOf = (kind: IdKind) =>
  z.string().startsWith(ID_PREFIXES[kind], { message: `expected ${ID_PREFIXES[kind]}* id` });

export const RunId = idOf("run");
export const TaskId = idOf("task");
export const ExecutionId = idOf("exec");
export const AgentId = idOf("agent");
/** A versioned source document (e.g. an untrusted document). */
export const SourceVersionId = idOf("source");
export const ArtifactVersionId = idOf("artifact");
export const ToolRequestId = idOf("tool");
export const IncidentId = idOf("incident");
export const ApprovalId = idOf("approval");
export const ToolApprovalId = idOf("toolApproval");
export const PlanId = idOf("plan");
export const RoomId = idOf("room");
export const PlayerId = idOf("player");
export const CommandId = idOf("command");
export const TraceId = idOf("trace");
export const EventId = idOf("event");
export const EdgeId = idOf("edge");
export const WorkflowId = idOf("workflow");
export const ProjectId = idOf("project");
export const UserId = idOf("user");

export type RunId = z.infer<typeof RunId>;
export type TaskId = z.infer<typeof TaskId>;
export type ExecutionId = z.infer<typeof ExecutionId>;
export type AgentId = z.infer<typeof AgentId>;
export type SourceVersionId = z.infer<typeof SourceVersionId>;
export type ArtifactVersionId = z.infer<typeof ArtifactVersionId>;
export type ToolRequestId = z.infer<typeof ToolRequestId>;
export type IncidentId = z.infer<typeof IncidentId>;
export type ApprovalId = z.infer<typeof ApprovalId>;
export type ToolApprovalId = z.infer<typeof ToolApprovalId>;
export type PlanId = z.infer<typeof PlanId>;
export type RoomId = z.infer<typeof RoomId>;
export type PlayerId = z.infer<typeof PlayerId>;
export type CommandId = z.infer<typeof CommandId>;
export type TraceId = z.infer<typeof TraceId>;
export type EventId = z.infer<typeof EventId>;
export type EdgeId = z.infer<typeof EdgeId>;
export type WorkflowId = z.infer<typeof WorkflowId>;
export type ProjectId = z.infer<typeof ProjectId>;
export type UserId = z.infer<typeof UserId>;

/** Generate a new prefixed ID. Uses Web Crypto, so it works in Node and the browser. */
export function newId(kind: IdKind): string {
  return ID_PREFIXES[kind] + globalThis.crypto.randomUUID().replace(/-/g, "");
}

/** Any node/entity ID that can appear in the graph. */
export const AnyEntityId = z.string().min(1);
