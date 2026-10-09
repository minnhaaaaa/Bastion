CREATE TABLE "project_connections" (
  "project_id" text PRIMARY KEY NOT NULL REFERENCES "projects"("id"),
  "repository" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
