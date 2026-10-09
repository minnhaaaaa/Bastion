import { describe, expect, it, vi } from "vitest";
import { newId } from "@bastion/contracts";
import type { PolicyEngine, PolicyRequest, WorkflowDefinition, ToolCall } from "@bastion/contracts";
import { PolicyToolGateway, WorkflowPolicyEngine, matches } from "./index";
import { MemoryBroker, MemoryJournal } from "../../../tests/member2-helpers";

function setup() {
  const call: ToolCall = { runId: newId("run"), agentId: newId("agent"), executionId: newId("exec"), taskId: newId("task"), traceId: newId("trace"), tool: crypto.randomUUID(), args: { path: "/work/secret" } };
  const definition: WorkflowDefinition = { name: crypto.randomUUID(), agents: [{ id: call.agentId, role: "RESEARCH", capabilities: ["fs.read:/work/**"] }], tasks: [{ id: call.taskId, agentId: call.agentId, title: crypto.randomUUID(), declaredDeps: [], sourceNames: [], produces: crypto.randomUUID(), retryPolicy: { maxAttempts: 2, idempotent: true } }], sources: [], attackPayloads: [], policyRules: [{ id: crypto.randomUUID(), decision: "ALLOW", description: "Generated grant", operation: "fs.read", resourcePattern: "/work/**" }] };
  const policy = new WorkflowPolicyEngine(definition);
  const request: PolicyRequest = { ...call, toolRequestId: newId("tool"), operation: "fs.read", resource: "/work/secret", inputClassification: "PUBLIC", inputVersionIds: [] };
  return { call, definition, policy, request };
}

describe("workflow policy", () => {
  it("requires both agent capability and a matching rule; deny takes precedence", () => {
    const { definition, request } = setup();
    expect(new WorkflowPolicyEngine(definition).evaluate(request).decision).toBe("ALLOW");
    expect(new WorkflowPolicyEngine({ ...definition, policyRules: [] }).evaluate(request).ruleId).toBe("default.deny");
    expect(new WorkflowPolicyEngine(definition).evaluate({ ...request, agentId: newId("agent") }).decision).toBe("DENY");
    const denyId = crypto.randomUUID();
    definition.policyRules.push({ id: denyId, description: "Generated restriction", decision: "DENY", operation: request.operation, resourcePattern: request.resource });
    expect(new WorkflowPolicyEngine(definition).evaluate(request).ruleId).toBe(denyId);
  });
  it("anchors globs and escapes regex syntax", () => {
    expect(matches("/work/*", "/work/a/b")).toBe(false);
    expect(matches("/work/**", "/work/a/b")).toBe(true);
    expect(matches("a.b", "axb")).toBe(false);
    expect(matches("/work/**", "/outside/work/a")).toBe(false);
  });
});

describe("gateway", () => {
  async function gateway(mode: "PROTECTED" | "BASELINE" = "PROTECTED") {
    const data = setup();
    const journal = new MemoryJournal(); const broker = new MemoryBroker();
    const source = await broker.ingestSource({ runId: data.call.runId, name: crypto.randomUUID(), content: crypto.randomUUID(), trust: "UNTRUSTED", classification: "PUBLIC", traceId: newId("trace") });
    const execute = vi.fn(async (): Promise<unknown> => crypto.randomUUID());
    const context = vi.fn(async () => ({ policy: data.policy as PolicyEngine, inputClassification: "PUBLIC" as const, inputVersionIds: [source.id], active: true, mode }));
    const gateway = new PolicyToolGateway({ journal, broker, context, normalize: async () => ({ operation: "fs.read", resource: "/work/secret" }), execute, withExecutionFence: async (_call, dispatch) => dispatch() });
    return { ...data, journal, broker, source, execute, context, gateway };
  }
  it("commits requested and decided before executing; never journals raw arguments", async () => {
    const s = await gateway();
    s.execute.mockImplementation(async () => { expect(s.journal.events.map(e => e.type)).toEqual(["tool.requested", "tool.decided"]); return "output"; });
    expect((await s.gateway.dispatch(s.call)).status).toBe("EXECUTED");
    expect(JSON.stringify(s.journal.events)).not.toContain('"args":');
  });
  it("denies quarantined inputs immediately before execution", async () => {
    const s = await gateway();
    s.journal.onCommitted(event => { if (event.type === "tool.decided") s.broker.unusable.add(s.source.id); });
    expect((await s.gateway.dispatch(s.call)).status).toBe("DENIED");
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("fails closed when policy or journal fails", async () => {
    const s = await gateway();
    s.context.mockRejectedValue(new Error("secret"));
    expect((await s.gateway.dispatch(s.call)).status).toBe("DENIED");
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.journal.events.some(e => e.type === "policy.unavailable")).toBe(true);
    expect(JSON.stringify(s.journal.events)).not.toContain("secret");
    const next = await gateway();
    vi.spyOn(next.journal, "append").mockRejectedValue(new Error("offline"));
    await expect(next.gateway.dispatch(next.call)).rejects.toThrow();
    expect(next.execute).not.toHaveBeenCalled();
  });
  it("records approval rules without executing", async () => {
    const s = await gateway();
    s.context.mockResolvedValue({ policy: { evaluate: () => ({ decision: "REQUIRE_APPROVAL", ruleId: crypto.randomUUID(), reason: "Human approval" }) }, inputClassification: "PUBLIC", inputVersionIds: [], active: true, mode: "PROTECTED" });
    expect((await s.gateway.dispatch(s.call)).status).toBe("DENIED");
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("does not relabel an attempted side effect as NOT_EXECUTED when it errors", async () => {
    const s = await gateway();
    s.execute.mockRejectedValue(new Error("Generated execution failure"));
    expect((await s.gateway.dispatch(s.call)).status).toBe("DENIED");
    expect(s.journal.events.filter(e => e.type === "tool.executed").map(e => e.payload.outcome)).toEqual(["ERROR"]);
  });
  it("labels baseline bypass but still blocks inactive executions", async () => {
    const s = await gateway("BASELINE");
    expect((await s.gateway.dispatch(s.call)).status).toBe("EXECUTED");
    expect(s.journal.events.some(e => e.type === "tool.decided" && e.payload.ruleId === "baseline.unprotected")).toBe(true);
    s.context.mockResolvedValue({ policy: s.policy, inputClassification: "PUBLIC", inputVersionIds: [], active: false, mode: "BASELINE" });
    expect((await s.gateway.dispatch(s.call)).status).toBe("DENIED");
    expect(s.execute).toHaveBeenCalledTimes(1);
  });
});
