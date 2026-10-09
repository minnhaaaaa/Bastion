import { expect, it, vi } from "vitest";
import { newId, type Workflow } from "@bastion/contracts";
import { compileTaskPlan } from "./task-planning";
import { createTestApp } from "./testing";

function generatedPlan() {
  return { name: crypto.randomUUID(), tasks: [{ key: crypto.randomUUID(), role: "BUILDER", title: crypto.randomUUID(), dependsOn: [] as string[], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 1, idempotent: true } }] };
}
it("new plans have no authority and reject model-supplied permissions, cycles, and unknown dependencies", () => {
  const plan = generatedPlan();
  const result = compileTaskPlan(plan);
  expect(result.agents.every(agent => agent.capabilities.length === 0)).toBe(true);
  expect(result.sources).toEqual([]);
  expect(result.policyRules).toEqual([]);
  expect(() => compileTaskPlan({ ...plan, policyRules: [{ decision: "ALLOW" }] })).toThrow();
  expect(() => compileTaskPlan({ ...plan, tasks: [{ ...plan.tasks[0], capabilities: ["proc.exec:*"] }] })).toThrow();
  expect(() => compileTaskPlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: [plan.tasks[0]!.key] }] })).toThrow();
  expect(() => compileTaskPlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: [crypto.randomUUID()] }] })).toThrow();
  expect(() => compileTaskPlan({ ...plan, tasks: [plan.tasks[0], plan.tasks[0]] })).toThrow();
});
it("adaptation preserves every security boundary, verification check, and dependency", () => {
  const definition = compileTaskPlan(generatedPlan());
  definition.sources.push({ name: crypto.randomUUID(), trust: "TRUSTED", classification: "INTERNAL", location: crypto.randomUUID() });
  definition.agents[0]!.capabilities.push("fs.read:/workspace/**");
  definition.policyRules.push({ id: crypto.randomUUID(), description: "review", decision: "REQUIRE_APPROVAL", operation: "fs.read", resourcePattern: "/workspace/**" });
  definition.tasks[0]!.sourceNames = [definition.sources[0]!.name];
  definition.acceptanceChecks = [{ id: crypto.randomUUID(), kind: "SOURCE_QUOTE", taskId: definition.tasks[0]!.id, pointers: ["/quote"], sourceNames: [definition.sources[0]!.name] }];
  const base: Workflow = { id: newId("workflow"), projectId: newId("project"), version: 1, createdAt: new Date().toISOString(), definition };
  const plan = { name: crypto.randomUUID(), tasks: definition.tasks.map(task => ({ taskId: task.id, title: crypto.randomUUID() })) };
  const result = compileTaskPlan(plan, base);
  expect(result).toEqual({ ...definition, name: plan.name, tasks: definition.tasks.map((task, i) => ({ ...task, title: plan.tasks[i]!.title })) });
  expect(() => compileTaskPlan({ ...plan, acceptanceChecks: [] }, base)).toThrow();
  expect(() => compileTaskPlan({ ...plan, tasks: [] }, base)).toThrow();
  expect(() => compileTaskPlan({ ...plan, tasks: [{ taskId: newId("task"), title: "remove verifier" }] }, base)).toThrow();
});
it("planning is owner-only, idempotent, pinned to the chosen workflow, and persists through the workflow API", async () => {
  const planner = vi.fn(async (instruction: string, base?: Workflow) => base ? compileTaskPlan({ name: instruction, tasks: base.definition.tasks.map(task => ({ taskId: task.id, title: instruction })) }, base) : compileTaskPlan(generatedPlan()));
  const test = await createTestApp({ taskPlanner: planner });
  try {
    const headers = test.auth(test.tokenA);
    const project = (await test.app.inject({ method: "POST", url: "/api/projects", headers, payload: { commandId: newId("command"), name: crypto.randomUUID() } })).json();
    const payload = { commandId: newId("command"), instruction: crypto.randomUUID() };
    const url = `/api/projects/${project.id}/task-plan`;
    expect((await test.app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "POST", url, payload, headers: test.auth(test.tokenB) })).statusCode).toBe(403);
    const prepared = await test.app.inject({ method: "POST", url, headers, payload });
    expect(prepared.statusCode).toBe(200);
    expect((await test.app.inject({ method: "POST", url, headers, payload })).json()).toEqual(prepared.json());
    expect(planner).toHaveBeenCalledTimes(1);
    expect((await test.app.inject({ url: `/api/workflows?projectId=${project.id}`, headers })).json()).toEqual([]);
    const saved = await test.app.inject({ method: "POST", url: "/api/workflows", headers, payload: { commandId: newId("command"), projectId: project.id, definition: prepared.json().definition } });
    expect(saved.statusCode).toBe(201);
    const workflow = saved.json<Workflow>();
    const adapted = await test.app.inject({ method: "POST", url, headers, payload: { commandId: newId("command"), instruction: payload.instruction, baseWorkflowId: workflow.id, baseWorkflowVersion: workflow.version } });
    expect(adapted.statusCode).toBe(200);
    expect(planner.mock.calls[1]![1]?.version).toBe(workflow.version);
    const otherProject = (await test.app.inject({ method: "POST", url: "/api/projects", headers, payload: { commandId: newId("command"), name: crypto.randomUUID() } })).json();
    expect((await test.app.inject({ method: "POST", url: `/api/projects/${otherProject.id}/task-plan`, headers, payload: { commandId: newId("command"), instruction: payload.instruction, baseWorkflowId: workflow.id, baseWorkflowVersion: workflow.version } })).statusCode).toBe(403);
    expect(planner).toHaveBeenCalledTimes(2);
  } finally { await test.close(); }
});
it("concurrent requests cannot borrow another operator's in-flight plan", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const test = await createTestApp({ taskPlanner: async () => { entered(); await gate; return compileTaskPlan(generatedPlan()); } });
  try {
    const create = async (token: string) => (await test.app.inject({ method: "POST", url: "/api/projects", headers: test.auth(token), payload: { commandId: newId("command"), name: crypto.randomUUID() } })).json();
    const a = await create(test.tokenA), b = await create(test.tokenB);
    const payload = { commandId: newId("command"), instruction: crypto.randomUUID() };
    const first = test.app.inject({ method: "POST", url: `/api/projects/${a.id}/task-plan`, headers: test.auth(test.tokenA), payload }).then(response => response);
    await started;
    const other = await test.app.inject({ method: "POST", url: `/api/projects/${b.id}/task-plan`, headers: test.auth(test.tokenB), payload });
    expect(other.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
  } finally { release(); await test.close(); }
});
it("quota failures reach the caller as actionable messages rather than invalid-plan errors", async () => {
  const { PiRuntimeAdapter } = await import("@bastion/runtime-pi");
  const { createTaskPlanner } = await import("./task-planning");
  const start = vi.spyOn(PiRuntimeAdapter.prototype, "startTask").mockResolvedValue({ sessionId: crypto.randomUUID() });
  const subscribe = vi.spyOn(PiRuntimeAdapter.prototype, "subscribe").mockImplementation((_id, sink) => { queueMicrotask(() => sink({ kind: "finished", ok: false, error: "PROVIDER_RATE_LIMITED" })); return () => {}; });
  try {
    const planner = createTaskPlanner({ authMode: "api-key", apiKey: crypto.randomUUID(), provider: crypto.randomUUID(), model: crypto.randomUUID(), baseUrl: "https://test.invalid", agentDir: process.cwd(), timeoutMs: 1000 }, process.cwd());
    await expect(planner(crypto.randomUUID())).rejects.toThrow("provider has reached its usage limit");
  } finally { start.mockRestore(); subscribe.mockRestore(); }
});

it("follow-up planning uses only the owner's completed clear output previews and pinned boundaries", async () => {
  const planner = vi.fn<import("./task-planning").TaskPlanner>(async (_instruction, base) => base!.definition);
  const test = await createTestApp({ taskPlanner: planner });
  try {
    const headers = test.auth(test.tokenA);
    const project = (await test.app.inject({ method: "POST", url: "/api/projects", headers, payload: { commandId: newId("command"), name: crypto.randomUUID() } })).json();
    const definition = compileTaskPlan(generatedPlan());
    const wf = (await test.app.inject({ method: "POST", url: "/api/workflows", headers, payload: { commandId: newId("command"), projectId: project.id, definition } })).json<Workflow>();
    const runId = newId("run"), traceId = newId("trace"), executionId = newId("exec");
    const task = definition.tasks[0]!;
    await test.journal.append(runId, [
      { runId, traceId, type: "run.created", payload: { projectId: project.id, workflowId: wf.id, workflowVersion: wf.version, mode: "PROTECTED" } },
      { runId, traceId, type: "run.planned", payload: { tasks: [{ taskId: task.id, agentId: task.agentId, role: definition.agents[0]!.role, title: task.title, declaredDeps: [], sourceIds: [], retryPolicy: task.retryPolicy }] } },
      { runId, traceId, type: "run.status_changed", payload: { from: "CREATED", to: "RUNNING" } },
      { runId, traceId, type: "task.state_changed", payload: { taskId: task.id, executionId, attempt: 1, from: "PENDING", to: "RUNNING" } },
    ]);
    const request = (token = test.tokenA) => test.app.inject({ method: "POST", url: `/api/projects/${project.id}/task-plan`, headers: test.auth(token), payload: { commandId: newId("command"), instruction: crypto.randomUUID(), contextRunId: runId } });
    expect((await request()).statusCode).toBe(409);
    const artifact = await test.broker.publish({ runId, name: task.produces, producerExecutionId: executionId, producerTaskId: task.id, content: crypto.randomUUID(), classification: "INTERNAL", traceId });
    await test.journal.append(runId, [
      { runId, traceId, type: "task.state_changed", payload: { taskId: task.id, executionId, attempt: 1, from: "RUNNING", to: "SUCCEEDED" } },
      { runId, traceId, type: "verification.completed", payload: { incidentId: null, checks: [{ name: crypto.randomUUID(), passed: true }] } },
      { runId, traceId, type: "run.status_changed", payload: { from: "RUNNING", to: "COMPLETED" } },
    ]);
    expect((await request(test.tokenB)).statusCode).toBe(403);
    expect((await request()).statusCode).toBe(200);
    expect(planner.mock.calls[0]![1]).toEqual(wf);
    expect(planner.mock.calls[0]![3]).toEqual({ runId, outputs: [{ artifactVersionId: artifact.id, name: artifact.name, preview: artifact.preview }] });
    await test.journal.append(runId, [{ runId, traceId, type: "artifact.trust_changed", payload: { artifactVersionId: artifact.id, from: "CLEAR", to: "INVALIDATED" } }]);
    expect((await request()).statusCode).toBe(409);
    expect(planner).toHaveBeenCalledTimes(1);
  } finally { await test.close(); }
});
