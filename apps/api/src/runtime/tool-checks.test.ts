import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { newId, type ToolGateway, type WorkflowDefinition } from "@bastion/contracts";
import { createTestApp } from "../testing";
import { executeToolChecks } from "./tool-checks";
import { acceptanceChecks } from "./verification";
import type { ExecutionContext } from "@bastion/orchestrator";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

it("accepts only a controller-issued, exact-call receipt for the latest successful execution", async () => {
  const app = await createTestApp(); cleanups.push(app.close);
  const runId = newId("run"), taskId = newId("task"), agentId = newId("agent"), executionId = newId("exec"), traceId = newId("trace");
  const project = (await app.app.inject({ method: "POST", url: "/api/projects", headers: app.auth(app.tokenA), payload: { commandId: newId("command"), name: crypto.randomUUID() } })).json();
  const check = { kind: "TOOL" as const, id: crypto.randomUUID(), taskId, tool: crypto.randomUUID(), args: { executable: "/bin/true", argv: [] } };
  const definition: WorkflowDefinition = { name: crypto.randomUUID(), agents: [{ id: agentId, role: "VERIFIER", capabilities: [] }], tasks: [{ id: taskId, agentId, title: crypto.randomUUID(), declaredDeps: [], sourceNames: [], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 2, idempotent: true } }], sources: [], policyRules: [], attackPayloads: [], acceptanceChecks: [check] };
  const wf = (await app.app.inject({ method: "POST", url: "/api/workflows", headers: app.auth(app.tokenA), payload: { commandId: newId("command"), projectId: project.id, definition } })).json();
  const envelope = { runId, traceId, taskId, agentId };
  await app.journal.append(runId, [
    { ...envelope, type: "run.created", payload: { projectId: project.id, workflowId: wf.id, workflowVersion: wf.version, mode: "PROTECTED" } },
    { ...envelope, type: "run.planned", payload: { tasks: [{ taskId, agentId, role: "VERIFIER", title: definition.tasks[0]!.title, declaredDeps: [], sourceIds: [], retryPolicy: definition.tasks[0]!.retryPolicy }] } },
    { ...envelope, type: "task.state_changed", payload: { taskId, executionId, attempt: 1, from: "PENDING", to: "RUNNING" } },
  ]);
  const context = { runId, traceId, executionId, task: (await app.journal.snapshot(runId))!.tasks[taskId]!, inputVersionIds: [], inputs: [], capabilities: [], produces: definition.tasks[0]!.produces } satisfies ExecutionContext;
  const gateway: ToolGateway = { dispatch: async call => {
    expect(call.args).toEqual(check.args);
    const toolRequestId = newId("tool");
    await app.journal.append(runId, [
      { ...envelope, type: "tool.requested", payload: { toolRequestId, executionId: call.executionId, agentId, tool: call.tool, operation: "proc.exec", resource: JSON.stringify([call.args.executable]), destination: null, argsHash: createHash("sha256").update(JSON.stringify(call.args)).digest("hex") } },
      { ...envelope, type: "tool.decided", payload: { toolRequestId, decision: "ALLOW", ruleId: crypto.randomUUID(), reason: "Test grant" } },
      { ...envelope, type: "tool.executed", payload: { toolRequestId, outcome: "SUCCESS" } },
    ]);
    return { status: "EXECUTED", toolRequestId, output: { stdout: "", stderr: "" } };
  } };
  const verify = async (def = definition) => acceptanceChecks((await app.journal.snapshot(runId))!, { definition: def, journal: app.journal, content: app.broker.content.bind(app.broker) });
  expect((await verify())[0]!.passed).toBe(false);
  expect(await executeToolChecks(context, [check], gateway, app.journal)).toBe(true);
  expect((await verify())[0]!.passed).toBe(false); // execution is still running
  await app.journal.append(runId, [{ ...envelope, type: "task.state_changed", payload: { taskId, executionId, attempt: 1, from: "RUNNING", to: "SUCCEEDED" } }]);
  expect((await verify())[0]!.passed).toBe(true);
  expect((await verify({ ...definition, acceptanceChecks: [{ ...check, args: { ...check.args, argv: [crypto.randomUUID()] } }] }))[0]!.passed).toBe(false);
  const next = newId("exec");
  await app.journal.append(runId, [{ ...envelope, type: "task.state_changed", payload: { taskId, executionId: next, attempt: 2, from: "PENDING", to: "RUNNING" } }]);
  expect((await verify())[0]!.passed).toBe(false);
  expect(await executeToolChecks({ ...context, executionId: next }, [check], { dispatch: async () => { throw new Error("sensitive failure"); } }, app.journal)).toBe(false);
  expect(JSON.stringify(await app.journal.read(runId))).not.toContain("sensitive failure");
});
