import { expect, it, vi } from "vitest";
import { newId, replay } from "@bastion/contracts";
import type { Run, Scheduler, Workflow, WorkflowRepository } from "@bastion/contracts";
import { WorkflowRunner } from "./index";
import { MemoryJournal, MemoryBroker } from "../../../tests/member2-helpers";

async function setup(mode: Run["mode"] = "PROTECTED") {
  const journal = new MemoryJournal(); const broker = new MemoryBroker();
  const projectId = newId("project"); const workflowId = newId("workflow"); const runId = newId("run"); const agentId = newId("agent"); const taskId = newId("task");
  const sourceName = crypto.randomUUID(); const location = crypto.randomUUID(); const payloadLocation = crypto.randomUUID(); const payloadId = crypto.randomUUID();
  const workflow: Workflow = { id: workflowId, projectId, version: 1, createdAt: new Date().toISOString(), definition: { name: crypto.randomUUID(), agents: [{ id: agentId, role: "VERIFIER", capabilities: [] }], tasks: [{ id: taskId, agentId, title: crypto.randomUUID(), declaredDeps: [], sourceNames: [sourceName], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 2, idempotent: true } }], sources: [{ name: sourceName, location, trust: "TRUSTED", classification: "INTERNAL" }], policyRules: [], attackPayloads: [{ id: payloadId, targetSourceName: sourceName, contentLocation: payloadLocation, label: crypto.randomUUID(), card: "POISON_DOCUMENT" }] } };
  const run: Run = { id: runId, workflowId, workflowVersion: 1, projectId, mode, status: "CREATED", startedAt: null, finishedAt: null };
  await journal.append(runId, [{ runId, traceId: newId("trace"), type: "run.created", payload: { projectId, workflowId, workflowVersion: 1, mode } }]);
  const repository: WorkflowRepository = { get: async () => workflow, create: async () => workflow, list: async () => [workflow] };
  const start = vi.fn<Scheduler["start"]>(async (_id, tasks) => {
    await journal.append(runId, [
      { runId, traceId: newId("trace"), type: "run.planned", payload: { tasks: tasks.map(t => ({ taskId: t.id, agentId: t.agentId, role: t.role, title: t.title, declaredDeps: t.declaredDeps, sourceIds: t.sourceIds, retryPolicy: t.retryPolicy })) } },
      ...tasks.map(t => ({ runId, traceId: newId("trace"), taskId: t.id, type: "task.state_changed" as const, payload: { taskId: t.id, executionId: newId("exec"), attempt: 1, from: "PENDING" as const, to: "SUCCEEDED" as const } })),
    ]);
  });
  const scheduler: Scheduler = { start, hold: async () => ({ heldExecutionIds: [] }), rerun: async () => {}, onTaskSettled: () => () => {} };
  const selectScheduler = vi.fn(() => scheduler);
  const load = vi.fn(async (path: string) => path === payloadLocation ? "generated attack content" : "generated source content");
  const verify = vi.fn(async () => [{ name: crypto.randomUUID(), passed: true }]);
  const runner = new WorkflowRunner({ workflows: repository, broker, journal, run: async () => run, load, scheduler: selectScheduler, snapshot: async () => replay(await journal.read(runId)), verify });
  return { runner, journal, broker, run, workflow, load, verify, selectScheduler, start, payloadId, location, payloadLocation, sourceName };
}

it("loads workflow locations, passes persisted source IDs, selects pinned mode and verifies", async () => {
  const s = await setup("BASELINE");
  await s.runner.start(s.run.id);
  expect(s.load).toHaveBeenCalledWith(s.location);
  expect(s.selectScheduler).toHaveBeenCalledWith("BASELINE");
  const tasks = s.start.mock.calls[0]![1];
  expect(tasks[0]!.id).toBe(s.workflow.definition.tasks[0]!.id);
  expect(s.broker.versions.has(tasks[0]!.sourceIds[0]!)).toBe(true);
  expect(s.verify).toHaveBeenCalledOnce();
  expect(replay(await s.journal.read(s.run.id)).run.status).toBe("COMPLETED");
});

it("installs a registered attack as an untrusted version without broadcasting payload content", async () => {
  const s = await setup();
  const versionId = await s.runner.applyAttack(s.run.id, s.payloadId);
  expect(s.load).toHaveBeenCalledWith(s.payloadLocation);
  const source = await s.broker.latestUsableSource(s.run.id, s.sourceName);
  expect(source?.id).toBe(versionId);
  expect(source?.trust).toBe("UNTRUSTED");
  await s.runner.start(s.run.id);
  expect(s.load).toHaveBeenCalledTimes(1);
  expect(s.start.mock.calls[0]![1][0]!.sourceIds).toEqual([versionId]);
  expect(JSON.stringify(s.journal.events)).not.toContain("generated attack content");
  await expect(s.runner.applyAttack(s.run.id, crypto.randomUUID())).rejects.toThrow("Unknown");
});

it("rejects unavailable pinned versions before loading sources", async () => {
  const s = await setup(); s.run.workflowVersion++;
  await expect(s.runner.start(s.run.id)).rejects.toThrow("Workflow start failed");
  expect(s.load).not.toHaveBeenCalled();
});

it("marks a failed verifier as FAILED", async () => {
  const s = await setup(); s.verify.mockResolvedValue([{ name: crypto.randomUUID(), passed: false }]);
  await s.runner.start(s.run.id);
  expect(replay(await s.journal.read(s.run.id)).run.status).toBe("FAILED");
});

it("fails closed when the trusted verifier throws", async () => {
  const s = await setup(); s.verify.mockRejectedValue(new Error("Generated verifier error"));
  await expect(s.runner.start(s.run.id)).rejects.toThrow("Workflow start failed");
  expect(replay(await s.journal.read(s.run.id)).run.status).toBe("FAILED");
});
