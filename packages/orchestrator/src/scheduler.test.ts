import { expect, it, vi } from "vitest";
import { newId } from "@bastion/contracts";
import type { AgentRuntimeAdapter, RuntimeEvent, TaskSpec, WorkflowDefinition } from "@bastion/contracts";
import { WorkflowScheduler } from "./index";
import { MemoryBroker, MemoryJournal } from "../../../tests/member2-helpers";

async function setup(parallelism: number, block = false) {
  const journal = new MemoryJournal(); const broker = new MemoryBroker();
  const runId = newId("run"); const agentId = newId("agent");
  const ids = Array.from({ length: 3 }, () => newId("task"));
  const source = await broker.ingestSource({ runId, name: crypto.randomUUID(), content: crypto.randomUUID(), classification: "PUBLIC", trust: "UNTRUSTED", traceId: newId("trace") });
  const definition: WorkflowDefinition = { name: crypto.randomUUID(), agents: [{ id: agentId, role: "BUILDER", capabilities: [] }], sources: [{ name: source.name, location: crypto.randomUUID(), trust: source.trust, classification: source.classification }], policyRules: [], attackPayloads: [], tasks: ids.map((id, i) => ({ id, agentId, title: crypto.randomUUID(), declaredDeps: i === 1 ? [ids[0]!] : [], sourceNames: i === 0 ? [source.name] : [], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 3, idempotent: true } })) };
  const tasks: TaskSpec[] = definition.tasks.map(t => ({ ...t, runId, role: "BUILDER", sourceIds: t.sourceNames.length ? [source.id] : [] }));
  const sessions = new Map<string, { sink?: (event: RuntimeEvent) => void; outputName: string }>();
  let active = 0; let peak = 0;
  const scheduler = new WorkflowScheduler({ journal, broker, parallelism, workflowForRun: async () => definition, workspaceForRun: async () => crypto.randomUUID(), withExecutionFence: async (_id, operation) => operation(), runtime: async context => {
    const runtime: AgentRuntimeAdapter = {
      startTask: async () => { active++; peak = Math.max(active, peak); const sessionId = crypto.randomUUID(); sessions.set(sessionId, { outputName: context.produces }); return { sessionId }; },
      requestStop: async id => { const session = sessions.get(id)!; if (session.sink) { active--; session.sink({ kind: "finished", ok: false, error: "STOPPED" }); session.sink = undefined; } },
      subscribe: (id, sink) => {
        const session = sessions.get(id)!; session.sink = sink;
        if (!block) queueMicrotask(() => { if (!session.sink) return; active--; sink({ kind: "output", name: session.outputName, content: crypto.randomUUID() }); sink({ kind: "finished", ok: true }); session.sink = undefined; });
        return () => { session.sink = undefined; };
      },
    };
    return runtime;
  } });
  return { scheduler, journal, broker, runId, ids, tasks, source, definition, sessions, peak: () => peak, unblock: () => { block = false; } };
}

it("bounds concurrency and consumes dependency artifacts through the broker", async () => {
  const s = await setup(1);
  await s.scheduler.start(s.runId, s.tasks);
  expect(s.peak()).toBe(1);
  expect(s.journal.events.filter(e => e.type === "task.state_changed" && e.payload.to === "SUCCEEDED")).toHaveLength(3);
  const first = s.journal.events.find(e => e.type === "task.state_changed" && e.taskId === s.ids[0] && e.payload.to === "SUCCEEDED")!;
  const second = s.journal.events.find(e => e.type === "task.state_changed" && e.taskId === s.ids[1] && e.payload.to === "RUNNING")!;
  expect(first.seq).toBeLessThan(second.seq);
  expect(s.broker.consumed).toHaveLength(2);
});

it("holds active tasks, prevents late publication, and preserves an independent branch during rerun", async () => {
  const s = await setup(2, true);
  const run = s.scheduler.start(s.runId, s.tasks);
  await vi.waitFor(() => expect(s.sessions.size).toBe(2));
  await s.scheduler.hold(s.runId, [s.ids[0]!, s.ids[1]!], "Generated quarantine");
  // The independent task completes normally while contaminated tasks remain held.
  for (const session of s.sessions.values()) if (session.sink) { session.sink({ kind: "output", name: session.outputName, content: crypto.randomUUID() }); session.sink({ kind: "finished", ok: true }); }
  await run;
  const independent = s.journal.events.find(e => e.type === "task.state_changed" && e.taskId === s.ids[2] && e.payload.to === "SUCCEEDED")!;
  expect(s.journal.events.some(e => e.type === "task.state_changed" && e.taskId === s.ids[0] && e.payload.to === "SUCCEEDED")).toBe(false);
  const replacement = await s.broker.ingestSource({ runId: s.runId, name: s.source.name, content: crypto.randomUUID(), trust: "TRUSTED", classification: "PUBLIC", previousVersionId: s.source.id, traceId: newId("trace") });
  s.broker.unusable.add(s.source.id); s.unblock();
  await s.scheduler.rerun(s.runId, [s.ids[0]!, s.ids[1]!], replacement.id);
  const successes = s.journal.events.filter(e => e.type === "task.state_changed" && e.payload.to === "SUCCEEDED");
  expect(successes).toHaveLength(3);
  expect(successes.filter(e => e.taskId === s.ids[2])).toEqual([independent]);
  const attemptOf = (taskId: string) => successes.find(e => e.taskId === taskId)!;
  // ids[0] ran and was stopped → a fresh second attempt.
  const rerun = attemptOf(s.ids[0]!);
  if (rerun.type === "task.state_changed") expect(rerun.payload.attempt).toBe(2);
  // ids[1] was held before it ever started → resumed as its first (never executed) attempt.
  const resumed = attemptOf(s.ids[1]!);
  const paused = s.journal.events.find(e => e.type === "task.state_changed" && e.taskId === s.ids[1] && e.payload.to === "PAUSED")!;
  if (resumed.type === "task.state_changed" && paused.type === "task.state_changed") {
    expect(resumed.payload.attempt).toBe(1);
    expect(resumed.payload.executionId).toBe(paused.payload.executionId);
  }
  expect(s.broker.consumed.some(c => c.inputVersionId === replacement.id)).toBe(true);
});

it("does not start a task whose source is quarantined", async () => {
  const s = await setup(2); s.broker.unusable.add(s.source.id);
  await expect(s.scheduler.start(s.runId, s.tasks)).rejects.toThrow("sources");
  expect(s.sessions.size).toBe(0);
});

it("rejects task sets different from the pinned definition", async () => {
  const s = await setup(1);
  await expect(s.scheduler.start(s.runId, [{ ...s.tasks[0]!, declaredDeps: [] }])).rejects.toThrow("Task set");
  expect(s.journal.events).toHaveLength(0);
});

it("rejects concurrent starts before asynchronous workflow loading completes", async () => {
  const s = await setup(1);
  const first = s.scheduler.start(s.runId, s.tasks);
  await expect(s.scheduler.start(s.runId, s.tasks)).rejects.toThrow("already scheduled");
  await first;
  expect(s.journal.events.filter(e => e.type === "run.planned")).toHaveLength(1);
});
