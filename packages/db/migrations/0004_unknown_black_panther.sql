CREATE TABLE "project_models" (
	"project_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"label" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_mode" text NOT NULL,
	"credential" text NOT NULL,
	"metadata" jsonb,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_models" (
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"bindings" jsonb NOT NULL,
	CONSTRAINT "workflow_models_workflow_id_version_pk" PRIMARY KEY("workflow_id","version")
);
--> statement-breakpoint
ALTER TABLE "project_models" ADD CONSTRAINT "project_models_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_models" ADD CONSTRAINT "project_models_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_models" ADD CONSTRAINT "workflow_models_workflow_id_version_workflows_id_version_fk" FOREIGN KEY ("workflow_id","version") REFERENCES "public"."workflows"("id","version") ON DELETE no action ON UPDATE no action;