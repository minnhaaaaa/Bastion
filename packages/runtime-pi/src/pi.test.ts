import { expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { AuthStorage, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, createAgentSession } from "@mariozechner/pi-coding-agent";
import { newId } from "@bastion/contracts";
import { gatewayTools, piConfigFromEnv } from "./index";

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
