import { expect, it } from "vitest";
import { newId, type Workflow, type WorkflowDefinition, type RunLauncher } from "../packages/contracts/src";
import { createTestApp, testWorkflowDefinition } from "../apps/api/src/testing";
import { withTaskInstruction } from "../apps/web/src/lib/workflow-draft";

it("persists a composed task version and starts it protected without modifying earlier runs", async () => {
  const launched: Parameters<RunLauncher["launch"]>[0][] = [];
  const test = await createTestApp({ launcher: { async launch(input) { launched.push(input); } } });
  const headers = test.auth(test.tokenA);
  const post = (url: string, payload: object) => test.app.inject({ method: "POST", url, headers, payload: { commandId: newId("command"), ...payload } });
  try {
    const project = await post("/api/projects", { name: crypto.randomUUID() });
    const definition: WorkflowDefinition = testWorkflowDefinition();
    definition.policyRules = [{ id: crypto.randomUUID(), description: "Review file writes", operation: "fs.write", resourcePattern: "/workspace/**", decision: "REQUIRE_APPROVAL" }];
    const created = await post("/api/workflows", { projectId: project.json().id, definition });
    expect(created.statusCode).toBe(201);
    const workflow = created.json<Workflow>();
    const firstRun = await post("/api/runs", { workflowId: workflow.id, mode: "PROTECTED" });
    expect(firstRun.statusCode).toBe(201);
    const updated = withTaskInstruction(workflow, workflow.definition.tasks[0]!.id, "Inspect the permissions and report findings");
    const version = await post(`/api/workflows/${workflow.id}/versions`, { definition: updated });
    expect(version.statusCode).toBe(201);
    const secondRun = await post("/api/runs", { workflowId: workflow.id, mode: "PROTECTED" });
    expect(secondRun.statusCode).toBe(201);
    const oldSnapshot = await test.app.inject({ url: `/api/runs/${firstRun.json().runId}`, headers });
    const newSnapshot = await test.app.inject({ url: `/api/runs/${secondRun.json().runId}`, headers });
    expect(oldSnapshot.json().run.workflowVersion).toBe(workflow.version);
    expect(newSnapshot.json().run.workflowVersion).toBe(version.json().version);
    expect(newSnapshot.json().run.mode).toBe("PROTECTED");
    expect(launched.map(input => input.workflow.version)).toEqual([workflow.version, version.json().version]);
    const stored = await test.app.inject({ url: `/api/workflows/${workflow.id}`, headers });
    expect(stored.json().definition).toEqual(updated);
    expect(stored.json().definition.policyRules).toEqual(workflow.definition.policyRules);
    const otherUser = await test.app.inject({ url: `/api/runs/${secondRun.json().runId}`, headers: test.auth(test.tokenB) });
    expect([403, 404]).toContain(otherUser.statusCode);
  } finally { await test.close(); }
});
