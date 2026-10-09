/**
 * Test-only: an in-process Postgres (PGlite) with all migrations applied.
 * Import from "@bastion/db/testing" in *.test.ts files only.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import { MIGRATIONS_DIR, type Db } from "./client";
import { newId, type NewRunEvent, type WorkflowDefinition } from "@bastion/contracts";
import { PgEventJournal } from "./journal";
import { PgWorkflowRepository, ProjectRepository } from "./repos";

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
  return { db: d as unknown as Db, close: () => client.close() };
}


/**
 * Test-only: generate a random workflow shape (ids generated per call) and start a run of it.
 * `shape` maps a local key → dependency keys, e.g. { a: [], b: ["a"], c: ["b"], d: [] }.
 */
export async function seedRun(db: Db, journal: PgEventJournal, shape: Record<string, string[]>) {
  const owner = newId("user");
  const project = await new ProjectRepository(db).create(owner, "test");
  const agent = newId("agent");
  const taskIds = Object.fromEntries(Object.keys(shape).map((k) => [k, newId("task")]));
  const retryPolicy = { maxAttempts: 1, idempotent: true };
  const definition: WorkflowDefinition = {
    name: "test",
    agents: [{ id: agent, role: "BUILDER", capabilities: [] }],
    sources: [],
    tasks: Object.entries(shape).map(([k, deps]) => ({
      id: taskIds[k]!,
      agentId: agent,
      title: k,
      declaredDeps: deps.map((d) => taskIds[d]!),
      sourceNames: [],
      produces: k,
      retryPolicy,
    })),
    policyRules: [],
    attackPayloads: [],
  };
  const workflow = await new PgWorkflowRepository(db).create(project.id, definition);
  const runId = newId("run");
  const traceId = newId("trace");
  await journal.append(runId, [
    { runId, traceId, type: "run.created", payload: { projectId: project.id, workflowId: workflow.id, workflowVersion: 1, mode: "PROTECTED" } },
    {
      runId,
      traceId,
      type: "run.planned",
      payload: {
        tasks: definition.tasks.map((t) => ({ taskId: t.id, agentId: agent, role: "BUILDER", title: t.title, declaredDeps: t.declaredDeps, sourceIds: [], retryPolicy })),
      },
    },
    { runId, traceId, type: "run.status_changed", payload: { from: "CREATED", to: "RUNNING" } },
  ] as NewRunEvent[]);
  return { owner, project, workflow, runId, traceId, agent, taskIds };
}

/** Test-only: emit a task state transition. */
export async function setTaskState(
  journal: PgEventJournal,
  runId: string,
  taskId: string,
  executionId: string,
  attempt: number,
  from: string,
  to: string,
) {
  await journal.append(runId, [
    { runId, traceId: newId("trace"), taskId, type: "task.state_changed", payload: { taskId, executionId, attempt, from, to } },
  ] as NewRunEvent[]);
}
