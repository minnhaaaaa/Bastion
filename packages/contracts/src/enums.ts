import { z } from "zod";

/** Execution lifecycle (ARCHITECTURE §4.2). SUCCEEDED never implies trusted. */
export const TaskState = z.enum(["PENDING", "READY", "RUNNING", "PAUSED", "SUCCEEDED", "FAILED"]);
export type TaskState = z.infer<typeof TaskState>;

/** Security state, tracked separately from execution state. Applies to tasks and artifacts. */
export const SecurityState = z.enum(["CLEAR", "REVIEW", "QUARANTINED", "INVALIDATED"]);
export type SecurityState = z.infer<typeof SecurityState>;

/** Declared trust of an input source, set by configuration, never by model output. */
export const SourceTrust = z.enum(["TRUSTED", "UNTRUSTED"]);
export type SourceTrust = z.infer<typeof SourceTrust>;

export const Classification = z.enum(["PUBLIC", "INTERNAL", "SYNTHETIC_SECRET"]);
export type Classification = z.infer<typeof Classification>;

export const RunStatus = z.enum([
  "CREATED",
  "RUNNING",
  "CONTAINED",
  "RECOVERING",
  "RECOVERED",
  "RECOVERY_FAILED",
  "COMPLETED",
  "FAILED",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const PolicyDecision = z.enum(["ALLOW", "DENY", "REQUIRE_APPROVAL"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const ToolOutcome = z.enum(["SUCCESS", "ERROR", "NOT_EXECUTED"]);
export type ToolOutcome = z.infer<typeof ToolOutcome>;

export const Severity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Severity = z.infer<typeof Severity>;

export const IncidentState = z.enum([
  "OPEN",
  "QUARANTINED",
  "RECOVERY_PLANNED",
  "RECOVERING",
  "RESOLVED",
  "RECOVERY_FAILED",
]);
export type IncidentState = z.infer<typeof IncidentState>;

export const ApprovalStatus = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CONSUMED"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const AgentRole = z.enum(["RESEARCH", "BUILDER", "VERIFIER"]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Demo round state machine (ARCHITECTURE §9). */
export const ArenaPhase = z.enum([
  "LOBBY",
  "BRIEFING",
  "ATTACK_WINDOW",
  "AGENT_EXECUTION",
  "INVESTIGATION",
  "CONTAINMENT",
  "RECOVERY",
  "REVEAL",
  "COMPLETE",
]);
export type ArenaPhase = z.infer<typeof ArenaPhase>;

export const ArenaRole = z.enum(["HOST", "ATTACKER", "DEFENDER"]);
export type ArenaRole = z.infer<typeof ArenaRole>;

export const RoomStatus = z.enum(["OPEN", "IN_PROGRESS", "FINISHED", "EXPIRED"]);
export type RoomStatus = z.infer<typeof RoomStatus>;

/** POISON_DOCUMENT is P0; the others are P1. */
export const AttackCard = z.enum(["POISON_DOCUMENT", "REDIRECT_TOOL", "LEAK_SECRET"]);
export type AttackCard = z.infer<typeof AttackCard>;

export const DefenderCard = z.enum([
  "INSPECT_SOURCE",
  "TRACE_DEPENDENCY",
  "REVIEW_TOOL_DECISION",
  "QUARANTINE",
  "APPROVE_RECOVERY",
  "SHARE_EVIDENCE",
]);
export type DefenderCard = z.infer<typeof DefenderCard>;

export const ActionOutcome = z.enum(["ACCEPTED", "REJECTED", "DUPLICATE"]);
export type ActionOutcome = z.infer<typeof ActionOutcome>;

/** Neo4j node labels (ARCHITECTURE §6.1). */
export const GraphNodeLabel = z.enum([
  "Agent",
  "TaskExecution",
  "Source",
  "ArtifactVersion",
  "ToolCall",
  "Resource",
  "Policy",
  "SecurityIncident",
]);
export type GraphNodeLabel = z.infer<typeof GraphNodeLabel>;

/** Neo4j relationship types (ARCHITECTURE §6.1). Also used as `dependency_edges.relation`. */
export const GraphRelType = z.enum([
  "EXECUTED",
  "CONSUMED",
  "PRODUCED",
  "DERIVED_FROM",
  "REQUESTED",
  "TARGETED",
  "GOVERNED_BY",
  "FLAGGED_IN",
  "DEPENDS_ON",
]);
export type GraphRelType = z.infer<typeof GraphRelType>;

export const VerificationOutcome = z.enum(["RECOVERED", "RECOVERY_FAILED"]);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;
