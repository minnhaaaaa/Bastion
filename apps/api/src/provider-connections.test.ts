import { RunService, type AppDeps } from "./context";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@bastion/db";
import { newId, type Workflow } from "@bastion/contracts";
import { piModelCatalog, type PiConfig } from "@bastion/runtime-pi";
import { ProviderConnections } from "./provider-connections";
import { createTestApp, testWorkflowDefinition } from "./testing";

export function testProviderConfig() {
  const entry = piModelCatalog().find(model => model.provider === "openai" && model.api === "openai-responses")!;
  const controller: PiConfig = { provider: entry.provider, model: entry.id, baseUrl: entry.baseUrl, authMode: "api-key", apiKey: randomUUID(), agentDir: "/tmp", timeoutMs: 5000 };
  return { controller, key: randomBytes(32).toString("hex") };
}
it("encrypts credentials, binds ciphertext to owner and connection, and never returns secrets", async () => {
  const providerConfig = testProviderConfig(), test = await createTestApp({ providerConfig });
  try {
    const headers = test.auth(test.tokenA), providers = test.providerConnections!;
    const saved = await test.app.inject({ method: "POST", url: "/api/provider-connections/controller", headers, payload: { label: randomUUID() } });
    expect(saved.statusCode).toBe(201); const id = saved.json().id;
    const [row] = await test.db.select().from(schema.providerConnections).where(eq(schema.providerConnections.id, id));
    expect(row!.credential).not.toContain(providerConfig.controller.authMode === "api-key" ? providerConfig.controller.apiKey : "");
    expect(providers.open(row!)).toEqual({ kind: "api-key", apiKey: (providerConfig.controller as { apiKey: string }).apiKey });
    expect(() => providers.open({ ...row!, ownerId: randomUUID() })).toThrow("credentials could not be opened");
    expect(() => providers.open({ ...row!, id: randomUUID() })).toThrow();
    const listing = await test.app.inject({ url: "/api/provider-connections", headers });
    expect(listing.body).not.toContain((providerConfig.controller as { apiKey: string }).apiKey);
    expect(listing.json().connections[0]).not.toHaveProperty("credential");
    const other = await test.app.inject({ url: "/api/provider-connections", headers: test.auth(test.tokenB) });
    expect(other.json().connections).toEqual([]);
    expect((await test.app.inject({ method: "POST", url: `/api/provider-connections/${id}/disable`, headers: test.auth(test.tokenB), payload: {} })).statusCode).toBe(404);
    const reopened = new ProviderConnections(test.db, providerConfig.controller, providerConfig.key);
    expect((await reopened.config(test.userA, id)).model).toBe(providerConfig.controller.model);
    await providers.disable(test.userA, id);
    expect((await test.db.select().from(schema.providerConnections))[0]!.credential).toBe("");
    await expect(reopened.config(test.userA, id)).rejects.toThrow("disconnected");
  } finally { await test.close(); }
});
it("pins different providers per agent, preserves boundaries and versions, and rejects foreign or disabled connections", async () => {
  const providerConfig = testProviderConfig(), launcher = { launch: vi.fn(async () => {}) }, planner = vi.fn<import("./task-planning").TaskPlanner>(async () => testWorkflowDefinition());
  const test = await createTestApp({ providerConfig, launcher, taskPlanner: planner });
  try {
    const headers = test.auth(test.tokenA), service = test.providerConnections!;
    const post = (url: string, payload: object, other = false) => test.app.inject({ method: "POST", url, payload, headers: other ? test.auth(test.tokenB) : headers });
    const project = (await post("/api/projects", { commandId: newId("command"), name: randomUUID() })).json();
    const first = await service.importController(test.userA, randomUUID());
    const entry = piModelCatalog().find(model => model.provider === "anthropic")!;
    const second = await service.addApiKey(test.userA, randomUUID(), entry.provider, entry.id, randomUUID());
    const foreign = (await post("/api/provider-connections/controller", { label: randomUUID() }, true)).json();
    expect((await post(`/api/projects/${project.id}/model`, { connectionId: foreign.id })).statusCode).toBe(404);
    expect((await post(`/api/projects/${project.id}/model`, { connectionId: first.id }, true)).statusCode).toBe(403);
    expect((await post(`/api/projects/${project.id}/model`, { connectionId: first.id })).statusCode).toBe(200);
    const definition = testWorkflowDefinition();
    const agent = { ...definition.agents[0]!, id: newId("agent") }; definition.agents.push(agent); definition.tasks[1]!.agentId = agent.id;
    const bad = await post("/api/workflows", { commandId: newId("command"), projectId: project.id, definition, agentConnections: { [agent.id]: foreign.id } });
    expect(bad.statusCode).toBe(404);
    expect((await test.db.select().from(schema.workflows)).length).toBe(0);
    const saved = await post("/api/workflows", { commandId: newId("command"), projectId: project.id, definition, agentConnections: { [agent.id]: second.id } });
    expect(saved.statusCode).toBe(201); const workflow = saved.json<Workflow>();
    expect(workflow.definition).toEqual(definition);
    const unavailable = new RunService({ db: test.db, launcher } as unknown as AppDeps, test.app.log);
    await expect(unavailable.start(workflow, "PROTECTED", [])).rejects.toThrow("Restore provider connection storage");
    expect(launcher.launch).not.toHaveBeenCalled();
    expect((await service.forExecution(workflow, definition.agents[0]!.id)).provider).toBe("openai");
    expect((await service.forExecution(workflow, agent.id)).provider).toBe("anthropic");
    await post(`/api/projects/${project.id}/model`, { connectionId: second.id });
    const next = await post(`/api/workflows/${workflow.id}/versions`, { commandId: newId("command"), definition });
    expect(next.statusCode).toBe(201);
    expect(await service.bindings(workflow.id, next.json().version)).toEqual(await service.bindings(workflow.id, workflow.version));
    const plan = await post(`/api/projects/${project.id}/task-plan`, { commandId: newId("command"), instruction: randomUUID() });
    expect(plan.statusCode).toBe(200);
    expect(planner.mock.calls[0]![4]).toMatchObject({ provider: "anthropic", model: entry.id });
    expect((await post(`/api/projects/${project.id}/task-plan`, { commandId: newId("command"), instruction: randomUUID(), connectionId: foreign.id })).statusCode).toBe(404);
    const run = await post("/api/runs", { commandId: newId("command"), workflowId: workflow.id, mode: "PROTECTED" });
    expect(run.statusCode).toBe(201);
    const exported = await test.app.inject({ url: `/api/runs/${run.json().runId}/export`, headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().runtime.bindings).toEqual(await service.bindings(workflow.id, next.json().version));
    expect(exported.json().runtime.connections.map((item: { provider: string }) => item.provider).sort()).toEqual(["anthropic", "openai"]);
    expect(exported.body).not.toContain((providerConfig.controller as { apiKey: string }).apiKey);
    launcher.launch.mockClear();
    await service.disable(test.userA, first.id);
    await expect(service.forExecution(workflow, definition.agents[0]!.id)).rejects.toThrow("disconnected");
    expect((await post("/api/runs", { commandId: newId("command"), workflowId: workflow.id, mode: "PROTECTED" })).statusCode).toBe(409);
    expect(launcher.launch).not.toHaveBeenCalled();
  } finally { await test.close(); }
});
