CREATE TYPE "public"."tool_approval_status" AS ENUM('PENDING', 'CONSUMED', 'REJECTED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "tool_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"tool_request_id" text NOT NULL,
	"status" "tool_approval_status" DEFAULT 'PENDING' NOT NULL,
	"action_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL,
	"actor_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_approvals_request_uq" ON "tool_approvals" USING btree ("tool_request_id");--> statement-breakpoint
CREATE INDEX "tool_approvals_run_status_idx" ON "tool_approvals" USING btree ("run_id","status");