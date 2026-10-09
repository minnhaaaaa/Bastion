CREATE TYPE "public"."action_outcome" AS ENUM('ACCEPTED', 'REJECTED', 'DUPLICATE');--> statement-breakpoint
CREATE TYPE "public"."agent_role" AS ENUM('RESEARCH', 'BUILDER', 'VERIFIER');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED');--> statement-breakpoint
CREATE TYPE "public"."arena_phase" AS ENUM('LOBBY', 'BRIEFING', 'ATTACK_WINDOW', 'AGENT_EXECUTION', 'INVESTIGATION', 'CONTAINMENT', 'RECOVERY', 'REVEAL', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."arena_role" AS ENUM('HOST', 'ATTACKER', 'DEFENDER');--> statement-breakpoint
CREATE TYPE "public"."classification" AS ENUM('PUBLIC', 'INTERNAL', 'SYNTHETIC_SECRET');--> statement-breakpoint
CREATE TYPE "public"."graph_rel" AS ENUM('EXECUTED', 'CONSUMED', 'PRODUCED', 'DERIVED_FROM', 'REQUESTED', 'TARGETED', 'GOVERNED_BY', 'FLAGGED_IN', 'DEPENDS_ON');--> statement-breakpoint
CREATE TYPE "public"."incident_state" AS ENUM('OPEN', 'QUARANTINED', 'RECOVERY_PLANNED', 'RECOVERING', 'RESOLVED', 'RECOVERY_FAILED');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('ALLOW', 'DENY', 'REQUIRE_APPROVAL');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('OPEN', 'IN_PROGRESS', 'FINISHED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."run_mode" AS ENUM('PROTECTED', 'BASELINE');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('CREATED', 'RUNNING', 'CONTAINED', 'RECOVERING', 'RECOVERED', 'RECOVERY_FAILED', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."security_state" AS ENUM('CLEAR', 'REVIEW', 'QUARANTINED', 'INVALIDATED');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."source_trust" AS ENUM('TRUSTED', 'UNTRUSTED');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('PENDING', 'READY', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."tool_outcome" AS ENUM('SUCCESS', 'ERROR', 'NOT_EXECUTED');--> statement-breakpoint
CREATE TABLE "agent_specs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"role" "agent_role" NOT NULL,
	"capability_profile" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"actor_id" text,
	"action_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arena_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"player_id" text NOT NULL,
	"command_id" text NOT NULL,
	"type" text NOT NULL,
	"outcome" "action_outcome" NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arena_players" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"session_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" "arena_role" NOT NULL,
	"display_alias" text NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"used_cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arena_rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"run_id" text,
	"join_code_hash" text NOT NULL,
	"host_token_hash" text NOT NULL,
	"status" "room_status" DEFAULT 'OPEN' NOT NULL,
	"phase" "arena_phase" DEFAULT 'LOBBY' NOT NULL,
	"phase_started_at" timestamp with time zone NOT NULL,
	"phase_ends_at" timestamp with time zone,
	"pending_attack_payload_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"host_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"source_ids" jsonb NOT NULL,
	"producer_execution_id" text NOT NULL,
	"classification" "classification" NOT NULL,
	"trust_state" "security_state" DEFAULT 'CLEAR' NOT NULL,
	"blob_ref" text NOT NULL,
	"preview" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_results" (
	"command_id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dependency_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"from_type" text NOT NULL,
	"from_id" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" text NOT NULL,
	"relation" "graph_rel" NOT NULL,
	"source_event_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"trace_id" text NOT NULL,
	"task_id" text,
	"agent_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"policy_set_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"rerun_task_ids" jsonb NOT NULL,
	"preserved_task_ids" jsonb NOT NULL,
	"replacement_source_version_id" text NOT NULL,
	"plan_digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version" integer NOT NULL,
	"mode" "run_mode" NOT NULL,
	"status" "run_status" DEFAULT 'CREATED' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "security_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source_version_id" text NOT NULL,
	"severity" "severity" NOT NULL,
	"state" "incident_state" DEFAULT 'OPEN' NOT NULL,
	"reason" text NOT NULL,
	"trigger_tool_request_id" text
);
--> statement-breakpoint
CREATE TABLE "source_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"trust" "source_trust" NOT NULL,
	"security_state" "security_state" DEFAULT 'CLEAR' NOT NULL,
	"classification" "classification" NOT NULL,
	"blob_ref" text NOT NULL,
	"preview" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"state" "task_state" NOT NULL,
	"security_state" "security_state" DEFAULT 'CLEAR' NOT NULL,
	"session_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_specs" (
	"id" text NOT NULL,
	"run_id" text NOT NULL,
	"role" "agent_role" NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"declared_deps" jsonb NOT NULL,
	"source_ids" jsonb NOT NULL,
	"retry_policy" jsonb NOT NULL,
	CONSTRAINT "task_specs_run_id_id_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "tool_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"operation" text NOT NULL,
	"resource" text NOT NULL,
	"destination" text,
	"args_hash" text NOT NULL,
	"decision" "policy_decision",
	"policy_rule_id" text,
	"reason" text,
	"execution_outcome" "tool_outcome"
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"project_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_id_version_pk" PRIMARY KEY("id","version")
);
--> statement-breakpoint
ALTER TABLE "agent_specs" ADD CONSTRAINT "agent_specs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_plan_id_recovery_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."recovery_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arena_actions" ADD CONSTRAINT "arena_actions_room_id_arena_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."arena_rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arena_actions" ADD CONSTRAINT "arena_actions_player_id_arena_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."arena_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arena_players" ADD CONSTRAINT "arena_players_room_id_arena_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."arena_rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arena_rooms" ADD CONSTRAINT "arena_rooms_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_producer_execution_id_task_executions_id_fk" FOREIGN KEY ("producer_execution_id") REFERENCES "public"."task_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_edges" ADD CONSTRAINT "dependency_edges_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_plans" ADD CONSTRAINT "recovery_plans_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_specs" ADD CONSTRAINT "task_specs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_requests" ADD CONSTRAINT "tool_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_requests" ADD CONSTRAINT "tool_requests_execution_id_task_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."task_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "arena_actions_command_uq" ON "arena_actions" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "arena_rooms_join_code_uq" ON "arena_rooms" USING btree ("join_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_version_uq" ON "artifact_versions" USING btree ("run_id","name","version");--> statement-breakpoint
CREATE INDEX "dep_edges_from_idx" ON "dependency_edges" USING btree ("run_id","from_id");--> statement-breakpoint
CREATE INDEX "dep_edges_to_idx" ON "dependency_edges" USING btree ("run_id","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_run_seq_uq" ON "events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "source_version_uq" ON "source_versions" USING btree ("run_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "task_exec_attempt_uq" ON "task_executions" USING btree ("run_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "workflows_project_idx" ON "workflows" USING btree ("project_id");