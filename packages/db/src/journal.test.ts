import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId, type NewRunEvent, type RunEvent } from "@bastion/contracts";
import { createTestDb } from "./testing";
import { PgEventJournal } from "./journal";
import { ProjectRepository, PgWorkflowRepository } from "./repos";
import * as t from "./schema";
import type { Db } from "./client";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

async function seedRun(journal: PgEventJournal) {
  const project = await new ProjectRepository(db).create(newId("user"), "p");
  const agent = newId("agent");
  const task = newId("task");
  const wf = await new PgWorkflowRepository(db).create(project.id, {
    name: "w",
    agents: [{ id: agent, role: "RESEARCH", capabilities: [] }],
    sources: [],
    tasks: [{ id: task, agentId: agent, title: "t", declaredDeps: [], sourceNames: [], produces: "x", retryPolicy: { maxAttempts: 1, idempotent: true } }],
    policyRules: [],
    attackPayloads: [],
  });
  const runId = newId("run");
  const traceId = newId("trace");
  await journal.append(runId, [
    { runId, traceId, type: "run.created", payload: { projectId: project.id, workflowId: wf.id, workflowVersion: wf.version, mode: "PROTECTED" } },
    { runId, traceId, type: "run.planned", payload: { tasks: [{ taskId: task, agentId: agent, role: "RESEARCH", title: "t", declaredDeps: [], sourceIds: [], retryPolicy: { maxAttempts: 1, idempotent: true } }] } },
  ] as NewRunEvent[]);
  return { runId, traceId, task };
}

describe("PgEventJournal", () => {
  it("assigns gap-free seq, persists, and materializes rows", async () => {
    const j = new PgEventJournal(db);
    const { runId, traceId, task } = await seedRun(j);
    const exec = newId("exec");
    await j.append(runId, [
      { runId, traceId, type: "task.state_changed", payload: { taskId: task, executionId: exec, attempt: 1, from: "PENDING", to: "RUNNING" } },
    ] as NewRunEvent[]);
    const all = await j.read(runId);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    const [row] = await db.select().from(t.taskExecutions).where(eq(t.taskExecutions.id, exec));
    expect(row?.state).toBe("RUNNING");
    const [run] = await db.select().from(t.runs).where(eq(t.runs.id, runId));
    expect(run?.status).toBe("CREATED");
  });

  it("notifies listeners after commit, in order, including re-entrant appends", async () => {
    const j = new PgEventJournal(db);
    const seen: { seq: number; inDb: boolean }[] = [];
    j.onCommitted(async (e: RunEvent) => {
      const rows = await db.select().from(t.events).where(eq(t.events.id, e.eventId));
      seen.push({ seq: e.seq, inDb: rows.length === 1 });
      if (e.type === "run.planned") {
        await j.append(e.runId, [{ runId: e.runId, traceId: e.traceId, type: "run.status_changed", payload: { from: "CREATED", to: "RUNNING" } }] as NewRunEvent[]);
      }
    });
    await seedRun(j);
    expect(seen).toEqual([
      { seq: 1, inDb: true },
      { seq: 2, inDb: true },
      { seq: 3, inDb: true },
    ]);
  });

  it("serializes concurrent appends without seq collisions", async () => {
    const j = new PgEventJournal(db);
    const { runId, traceId } = await seedRun(j);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        j.append(runId, [{ runId, traceId, type: "alert.suspicious_content", payload: { targetId: "x", detector: "d", reason: "r", severity: "LOW" } }] as NewRunEvent[]),
      ),
    );
    const seqs = (await j.read(runId)).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("rejects invalid events atomically", async () => {
    const j = new PgEventJournal(db);
    const { runId, traceId } = await seedRun(j);
    await expect(
      j.append(runId, [
        { runId, traceId, type: "alert.suspicious_content", payload: { targetId: "x", detector: "d", reason: "r", severity: "LOW" } },
        { runId, traceId, type: "alert.suspicious_content", payload: { targetId: "x" } },
      ] as unknown as NewRunEvent[]),
    ).rejects.toThrow();
    expect(await j.read(runId)).toHaveLength(2);
  });

  it("rebuilds the snapshot from Postgres after restart", async () => {
    const j1 = new PgEventJournal(db);
    const { runId } = await seedRun(j1);
    const s1 = await j1.snapshot(runId);
    const s2 = await new PgEventJournal(db).snapshot(runId);
    expect(s2).toEqual(s1);
  });
});

describe("PgWorkflowRepository", () => {
  it("versions workflows immutably", async () => {
    const project = await new ProjectRepository(db).create(newId("user"), "p");
    const repo = new PgWorkflowRepository(db);
    const agent = newId("agent");
    const def = (title: string) => ({
      name: "w",
      agents: [{ id: agent, role: "RESEARCH" as const, capabilities: [] }],
      sources: [],
      tasks: [{ id: newId("task"), agentId: agent, title, declaredDeps: [], sourceNames: [], produces: "x", retryPolicy: { maxAttempts: 1, idempotent: true } }],
      policyRules: [],
      attackPayloads: [],
    });
    const v1 = await repo.create(project.id, def("one"));
    const v2 = await repo.createVersion(v1.id, def("two"));
    expect(v2?.version).toBe(2);
    expect((await repo.get(v1.id))?.definition.tasks[0]?.title).toBe("two");
    expect((await repo.getVersion(v1.id, 1))?.definition.tasks[0]?.title).toBe("one");
    expect(await repo.list(project.id)).toHaveLength(1);
  });
});
