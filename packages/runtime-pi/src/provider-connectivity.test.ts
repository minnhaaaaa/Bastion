import { it, expect } from "vitest";
import { resolve } from "node:path";
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { piConfigFromEnv, piModelRegistry } from "./index";

it.skipIf(process.env.BASTION_PROVIDER_HTTP_DIAGNOSTIC !== "enabled")("custom provider answers a bounded non-streaming HTTP probe", async () => {
  process.loadEnvFile(resolve(".env"));
  const config = piConfigFromEnv();
  if (config.authMode !== "api-key" || config.customModel?.api !== "openai-completions") throw new Error("Probe requires an explicitly configured compatible custom API-key provider");
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: `Reply with this identifier only: ${crypto.randomUUID()}` }], max_tokens: 256, stream: false }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json() as { choices?: { message?: { content?: string } }[] };
  console.log({ httpStatus: response.status, hasCompletion: !!body.choices?.[0]?.message?.content });
  expect(response.ok).toBe(true);
  expect(body.choices?.[0]?.message?.content).toBeTruthy();
}, 25000);

it.skipIf(process.env.BASTION_PROVIDER_DIAGNOSTIC !== "enabled")("configured provider completes a real no-tool request", async () => {
  process.loadEnvFile(resolve(".env"));
  const config = piConfigFromEnv();
  const { model, modelRegistry, authStorage } = piModelRegistry(config);
  const cwd = process.env.SANDBOX_WORKSPACE_PATH;
  if (!cwd) throw new Error("SANDBOX_WORKSPACE_PATH required");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: config.agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: config.agentDir, model, modelRegistry, authStorage, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin", tools: [], customTools: [] });
  let failure = "", completed = false;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      completed = event.message.stopReason !== "error" && event.message.stopReason !== "aborted";
      failure = event.message.errorMessage ?? "";
    }
  });
  const timer = setTimeout(() => { void session.abort(); }, config.timeoutMs);
  try {
    expect(session.getActiveToolNames()).toEqual([]);
    await session.prompt(`Reply with exactly this text: ${crypto.randomUUID()}`, { expandPromptTemplates: false });
    if (failure) console.log({ provider: config.provider, diagnostic: config.authMode === "api-key" ? failure.replaceAll(config.apiKey, "[redacted]") : "Provider request failed; OAuth details withheld" });
    expect(completed).toBe(true);
  } finally { clearTimeout(timer); unsubscribe(); session.dispose(); }
}, 900000);
