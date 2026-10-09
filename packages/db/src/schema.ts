/**
 * Authoritative PostgreSQL schema (ARCHITECTURE §7).
 * Enum values come from @bastion/contracts so DB and wire types cannot drift.
 * Neo4j is a projection of `events` + `dependency_edges`; it is never written to directly.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import * as C from "@bastion/contracts";

const opts = <T extends readonly [string, ...string[]]>(e: { options: T }) => e.options as unknown as [T[number], ...T[number][]];

export const runStatus = pgEnum("run_status", opts(C.RunStatus));
export const runMode = pgEnum("run_mode", ["PROTECTED", "BASELINE"]);
export const taskState = pgEnum("task_state", opts(C.TaskState));
export const securityState = pgEnum("security_state", opts(C.SecurityState));
export const sourceTrust = pgEnum("source_trust", opts(C.SourceTrust));
export const classification = pgEnum("classification", opts(C.Classification));
export const agentRole = pgEnum("agent_role", opts(C.AgentRole));
export const policyDecision = pgEnum("policy_decision", opts(C.PolicyDecision));
export const toolOutcome = pgEnum("tool_outcome", opts(C.ToolOutcome));
export const severity = pgEnum("severity", opts(C.Severity));
export const incidentState = pgEnum("incident_state", opts(C.IncidentState));
export const approvalStatus = pgEnum("approval_status", opts(C.ApprovalStatus));
export const graphRel = pgEnum("graph_rel", opts(C.GraphRelType));
export const arenaPhase = pgEnum("arena_phase", opts(C.ArenaPhase));
export const arenaRole = pgEnum("arena_role", opts(C.ArenaRole));
export const roomStatus = pgEnum("room_status", opts(C.RoomStatus));
export const actionOutcome = pgEnum("action_outcome", opts(C.ActionOutcome));

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  policySetId: text("policy_set_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agentSpecs = pgTable("agent_specs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  role: agentRole("role").notNull(),
  capabilityProfile: jsonb("capability_profile").$type<string[]>().notNull(),
});

/** Workflow definitions are data (validated by contracts WorkflowDefinition), versioned, never hardcoded. */
export const workflows = pgTable(
  "workflows",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    projectId: text("project_id").notNull().references(() => projects.id),
    definition: jsonb("definition").$type<C.WorkflowDefinition>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] }), index("workflows_project_idx").on(t.projectId)],
);

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  /** (workflowId, workflowVersion) → workflows; validated in code (composite key). */
  workflowId: text("workflow_id").notNull(),
  workflowVersion: integer("workflow_version").notNull(),
  mode: runMode("mode").notNull(),
  status: runStatus("status").notNull().default("CREATED"),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
});

/** Task IDs are logical and unique within a run → composite key. */
export const taskSpecs = pgTable(
  "task_specs",
  {
    id: text("id").notNull(),
    runId: text("run_id").notNull().references(() => runs.id),
    role: agentRole("role").notNull(),
    agentId: text("agent_id").notNull(),
    title: text("title").notNull(),
    declaredDeps: jsonb("declared_deps").$type<string[]>().notNull(),
    sourceIds: jsonb("source_ids").$type<string[]>().notNull(),
    retryPolicy: jsonb("retry_policy").$type<C.RetryPolicy>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] })],
);

export const taskExecutions = pgTable(
  "task_executions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    taskId: text("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    state: taskState("state").notNull(),
    securityState: securityState("security_state").notNull().default("CLEAR"),
    sessionId: text("session_id"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [uniqueIndex("task_exec_attempt_uq").on(t.runId, t.taskId, t.attempt)],
);

export const sourceVersions = pgTable(
  "source_versions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    trust: sourceTrust("trust").notNull(),
    securityState: securityState("security_state").notNull().default("CLEAR"),
    classification: classification("classification").notNull(),
    blobRef: text("blob_ref").notNull(),
    preview: text("preview").notNull(),
  },
  (t) => [uniqueIndex("source_version_uq").on(t.runId, t.name, t.version)],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceIds: jsonb("source_ids").$type<string[]>().notNull(),
    producerExecutionId: text("producer_execution_id").notNull().references(() => taskExecutions.id),
    classification: classification("classification").notNull(),
    trustState: securityState("trust_state").notNull().default("CLEAR"),
    blobRef: text("blob_ref").notNull(),
    preview: text("preview").notNull(),
  },
  (t) => [uniqueIndex("artifact_version_uq").on(t.runId, t.name, t.version)],
);

/** Authoritative observed edges; Neo4j projection is rebuilt from these + events. */
export const dependencyEdges = pgTable(
  "dependency_edges",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    fromType: text("from_type").notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: text("to_id").notNull(),
    relation: graphRel("relation").notNull(),
    sourceEventId: text("source_event_id").notNull(),
  },
  (t) => [index("dep_edges_from_idx").on(t.runId, t.fromId), index("dep_edges_to_idx").on(t.runId, t.toId)],
);

export const toolRequests = pgTable("tool_requests", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  executionId: text("execution_id").notNull().references(() => taskExecutions.id),
  agentId: text("agent_id").notNull(),
  toolName: text("tool_name").notNull(),
  operation: text("operation").notNull(),
  resource: text("resource").notNull(),
  destination: text("destination"),
  argsHash: text("args_hash").notNull(),
  decision: policyDecision("decision"),
  policyRuleId: text("policy_rule_id"),
  reason: text("reason"),
  executionOutcome: toolOutcome("execution_outcome"),
});

export const securityIncidents = pgTable("security_incidents", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  sourceVersionId: text("source_version_id").notNull().references(() => sourceVersions.id),
  severity: severity("severity").notNull(),
  state: incidentState("state").notNull().default("OPEN"),
  reason: text("reason").notNull(),
  triggerToolRequestId: text("trigger_tool_request_id"),
});

export const recoveryPlans = pgTable("recovery_plans", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull().references(() => securityIncidents.id),
  rerunTaskIds: jsonb("rerun_task_ids").$type<string[]>().notNull(),
  preservedTaskIds: jsonb("preserved_task_ids").$type<string[]>().notNull(),
  replacementSourceVersionId: text("replacement_source_version_id").notNull(),
  planDigest: text("plan_digest").notNull(),
});

export const approvalRequests = pgTable("approval_requests", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull().references(() => securityIncidents.id),
  planId: text("plan_id").notNull().references(() => recoveryPlans.id),
  actorId: text("actor_id"),
  actionDigest: text("action_digest").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: approvalStatus("status").notNull().default("PENDING"),
});

/** Append-only journal. seq is gap-free per run; assign inside the insert transaction. */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    seq: integer("seq").notNull(),
    traceId: text("trace_id").notNull(),
    taskId: text("task_id"),
    agentId: text("agent_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("events_run_seq_uq").on(t.runId, t.seq)],
);

/** Idempotency for REST commands (commandId → stored result). */
export const commandResults = pgTable("command_results", {
  commandId: text("command_id").primaryKey(),
  actorId: text("actor_id").notNull(),
  route: text("route").notNull(),
  status: integer("status").notNull(),
  body: jsonb("body").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const arenaRooms = pgTable(
  "arena_rooms",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    runId: text("run_id").references(() => runs.id),
    joinCodeHash: text("join_code_hash").notNull(),
    hostTokenHash: text("host_token_hash").notNull(),
    status: roomStatus("status").notNull().default("OPEN"),
    phase: arenaPhase("phase").notNull().default("LOBBY"),
    phaseStartedAt: ts("phase_started_at").notNull(),
    phaseEndsAt: ts("phase_ends_at"),
    /** Attack payload ids queued during ATTACK_WINDOW, installed by the RunLauncher before scheduling. */
    pendingAttackPayloadIds: jsonb("pending_attack_payload_ids").$type<string[]>().notNull().default([]),
    /** Incremented by host reset; actions and reveals are scoped to the current round. */
    round: integer("round").notNull().default(1),
    /** Host pause freezes the round clock and player actions (agents keep running). */
    paused: boolean("paused").notNull().default(false),
    pausedRemainingMs: integer("paused_remaining_ms"),
    hostId: text("host_id").notNull(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [uniqueIndex("arena_rooms_join_code_uq").on(t.joinCodeHash)],
);

export const arenaPlayers = pgTable("arena_players", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => arenaRooms.id),
  sessionId: text("session_id").notNull(),
  /** Hash of the player bearer token. */
  tokenHash: text("token_hash").notNull(),
  role: arenaRole("role").notNull(),
  displayAlias: text("display_alias").notNull(),
  connected: boolean("connected").notNull().default(false),
  cards: jsonb("cards").$type<string[]>().notNull().default([]),
  usedCards: jsonb("used_cards").$type<string[]>().notNull().default([]),
  evidence: jsonb("evidence").$type<{ id: string; kind: string; summary: string }[]>().notNull().default([]),
  joinedAt: ts("joined_at").notNull().defaultNow(),
});

export const arenaActions = pgTable(
  "arena_actions",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull().references(() => arenaRooms.id),
    playerId: text("player_id").notNull().references(() => arenaPlayers.id),
    commandId: text("command_id").notNull(),
    type: text("type").notNull(),
    outcome: actionOutcome("outcome").notNull(),
    message: text("message").notNull().default(""),
    round: integer("round").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("arena_actions_command_uq").on(t.commandId)],
);
