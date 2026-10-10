import { expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { AuthStorage, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, createAgentSession } from "@mariozechner/pi-coding-agent";
import { newId } from "@bastion/contracts";
import { gatewayTools, piConfigFromEnv, PiRuntimeAdapter } from "./index";

it("real installed Pi registers only gateway-backed file/http/exec tools", async () => {
  const dispatch = vi.fn(async () => ({ status: "DENIED" as const, toolRequestId: newId("tool"), ruleId: "default.deny", reason: "Generated test denial" }));
  const identity = { runId: newId("run"), agentId: newId("agent"), taskId: newId("task"), executionId: newId("exec"), traceId: newId("trace") };
  const definitions = ["read", "http_request", "bash"].map(name => ({ name, label: name, description: crypto.randomUUID(), parameters: Type.Object({ input: Type.String() }) }));
  const tools = gatewayTools(definitions, { dispatch }, identity);
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.create(authStorage, "");
  const model = modelRegistry.getAll()[0]!;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: process.cwd(), model, authStorage, modelRegistry, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(), noTools: "builtin", tools: definitions.map(t => t.name), customTools: tools });
  try {
    expect(session.getActiveToolNames().sort()).toEqual(definitions.map(t => t.name).sort());
    // Exercise the executable tool registered in the REAL Pi Agent, not merely our wrapper.
    for (const tool of session.agent.state.tools!) await tool.execute(crypto.randomUUID(), { input: crypto.randomUUID() });
    expect(dispatch).toHaveBeenCalledTimes(3);
    for (const [call] of dispatch.mock.calls as unknown as [{ executionId: string; agentId: string }][]) expect(call).toMatchObject(identity);
  } finally { session.dispose(); }
});

it("requires explicit provider/model/key/path/timeout configuration", () => {
  expect(() => piConfigFromEnv({})).toThrow();
  expect(() => piConfigFromEnv({ PI_PROVIDER: crypto.randomUUID(), PI_MODEL: crypto.randomUUID(), PI_API_KEY: crypto.randomUUID(), PI_AGENT_DIR: process.cwd(), PI_TIMEOUT_MS: "0" })).toThrow();
});

it("fails a task on its deadline even when the SDK ignores abort", async () => {
  const model = ModelRegistry.create(AuthStorage.inMemory(), "").getAll()[0]!;
  const adapter = new PiRuntimeAdapter({
    config: { authMode: "api-key", provider: model.provider, model: model.id, baseUrl: model.baseUrl, apiKey: crypto.randomUUID(), agentDir: process.cwd(), timeoutMs: 20 },
    tools: [], gateway: { dispatch: async () => { throw new Error("No tools expected"); } },
    taskContext: async () => ({ executionId: newId("exec"), traceId: newId("trace"), cwd: process.cwd(), prompt: crypto.randomUUID(), outputName: crypto.randomUUID() }),
  });
  const { sessionId } = await adapter.startTask({ runId: newId("run"), taskId: newId("task"), agentId: newId("agent"), inputArtifactIds: [], capabilities: [], workspaceId: process.cwd() });
  const live = (adapter as unknown as { sessions: Map<string, { session: Awaited<ReturnType<typeof createAgentSession>>["session"] }> }).sessions.get(sessionId)!;
  vi.spyOn(live.session, "prompt").mockImplementation(() => new Promise(() => {}));
  const abort = vi.spyOn(live.session, "abort").mockImplementation(() => new Promise(() => {}));
  const events: unknown[] = [];
  await new Promise<void>(resolve => adapter.subscribe(sessionId, event => { events.push(event); if (event.kind === "finished") resolve(); }));
  expect(events).toEqual([{ kind: "finished", ok: false, error: "TIMEOUT" }]);
  expect(abort).toHaveBeenCalled();
});

it("registers controller reporting alongside gateway tools in the installed Pi session", async () => {
  const model = ModelRegistry.create(AuthStorage.inMemory(), "").getAll()[0]!;
  const receipt = { incidentId: newId("incident"), sourceVersionId: newId("source"), state: "OPEN" };
  const reportFinding = vi.fn(async () => receipt);
  const adapter = new PiRuntimeAdapter({
    config: { authMode: "api-key", provider: model.provider, model: model.id, baseUrl: model.baseUrl, apiKey: crypto.randomUUID(), agentDir: process.cwd(), timeoutMs: 1000 },
    tools: [], gateway: { dispatch: async () => { throw new Error("Reporting is not a file or network action"); } }, reportFinding,
    taskContext: async () => ({ executionId: newId("exec"), traceId: newId("trace"), cwd: process.cwd(), prompt: crypto.randomUUID(), outputName: crypto.randomUUID() }),
  });
  const { sessionId } = await adapter.startTask({ runId: newId("run"), taskId: newId("task"), agentId: newId("agent"), inputArtifactIds: [], capabilities: [], workspaceId: process.cwd() });
  const live = (adapter as unknown as { sessions: Map<string, { session: Awaited<ReturnType<typeof createAgentSession>>["session"] }> }).sessions.get(sessionId)!;
  try {
    expect(live.session.getActiveToolNames()).toEqual(["report_prompt_injection"]);
    const tool = live.session.agent.state.tools![0]!;
    await tool.execute(crypto.randomUUID(), { sourceVersionId: receipt.sourceVersionId, evidence: crypto.randomUUID(), reason: crypto.randomUUID(), severity: "HIGH" });
    expect(reportFinding).toHaveBeenCalledTimes(1);
  } finally { live.session.dispose(); }
});
