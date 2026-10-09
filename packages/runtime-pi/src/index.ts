import { providerFailureCode } from "./provider-failure";
/**
 * @bastion/runtime-pi — owner: Member 2
 * Pi-backed AgentRuntimeAdapter. All file/network/process tools must route through ToolGateway.
 * See TEAM_PLAN.md and packages/contracts/src/ports.ts.
 */
import { AuthStorage, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, createAgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { AgentRunRequest, AgentRuntimeAdapter, RuntimeEvent, ToolCall, ToolGateway } from "@bastion/contracts";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { privatePiTraceWriter, type PiTraceRecord } from "./trace";
export { privatePiTraceWriter } from "./trace";
export type { PiTraceRecord } from "./trace";

export type GatewayTool = { name: string; label: string; description: string; parameters: TSchema };
export type PiTaskContext = {
  executionId: string;
  traceId: string;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  outputName: string;
};
type PiConnection = { provider: string; model: string; baseUrl: string; agentDir: string; timeoutMs: number; traceDirectory?: string };
export type PiConfig = PiConnection & (
  | { authMode: "api-key"; apiKey: string }
  | { authMode: "oauth"; authFile: string }
);
export function piConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PiConfig {
  const required = (key: string) => { const value = env[key]; if (!value?.trim()) throw new Error(`Missing ${key}`); return value; };
  const timeoutMs = Number(required("PI_TIMEOUT_MS"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid PI_TIMEOUT_MS");
  const baseUrl = required("PI_BASE_URL");
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid PI_BASE_URL");
  const connection = { provider: required("PI_PROVIDER"), model: required("PI_MODEL"), baseUrl, agentDir: required("PI_AGENT_DIR"), timeoutMs, ...(env.PI_TRACE_DIRECTORY?.trim() ? { traceDirectory: env.PI_TRACE_DIRECTORY } : {}) };
  const authMode = required("PI_AUTH_MODE");
  if (authMode === "api-key") {
    if (connection.provider === "openai-codex") throw new Error("openai-codex requires PI_AUTH_MODE=oauth");
    return { ...connection, authMode, apiKey: required("PI_API_KEY") };
  }
  if (authMode === "oauth") {
    // Only the Codex subscription path is supported here. Claude uses an explicit API key.
    if (connection.provider !== "openai-codex") throw new Error("OAuth mode requires PI_PROVIDER=openai-codex; Claude/OpenRouter use api-key mode");
    const authFile = required("PI_AUTH_FILE");
    if (!isAbsolute(authFile)) throw new Error("PI_AUTH_FILE must be an absolute path");
    return { ...connection, authMode, authFile };
  }
  throw new Error("PI_AUTH_MODE must be api-key or oauth");
}

/** Explicit credentials only: never silently use another account or provider environment key. */
export function piAuthStorage(config: PiConfig): AuthStorage {
  if (config.authMode === "api-key") {
    const auth = AuthStorage.inMemory();
    auth.setRuntimeApiKey(config.provider, config.apiKey);
    return auth;
  }
  if (!existsSync(config.authFile)) throw new Error("Codex login missing; run pnpm agent:login");
  const auth = AuthStorage.create(config.authFile);
  const credential = auth.get(config.provider);
  if (auth.drainErrors().length || credential?.type !== "oauth" || !credential.access || !credential.refresh || !Number.isFinite(credential.expires)) {
    throw new Error("Invalid Codex login; run pnpm agent:login");
  }
  return auth;
}

export function piModelRegistry(config: PiConfig) {
  const authStorage = piAuthStorage(config);
  // Empty path prevents models.json loading and command-based credential resolvers.
  const modelRegistry = ModelRegistry.create(authStorage, "");
  const model = modelRegistry.find(config.provider, config.model);
  if (!model) throw new Error("Configured Pi model does not exist; run pnpm agent:models");
  // A subscription token must never be sent to an arbitrary configured endpoint.
  if (config.authMode === "oauth" && config.baseUrl.replace(/\/$/, "") !== model.baseUrl.replace(/\/$/, "")) {
    throw new Error("PI_BASE_URL must match the installed Codex provider endpoint; run pnpm agent:models");
  }
  return { authStorage, modelRegistry, model: { ...model, baseUrl: config.baseUrl } };
}

export function piProviderModels(provider: string) {
  return ModelRegistry.create(AuthStorage.inMemory(), "").getAll()
    .filter(model => model.provider === provider)
    .map(({ id, baseUrl }) => ({ id, baseUrl }));
}

export async function loginCodex(authFile: string, callbacks: Parameters<AuthStorage["login"]>[1]) {
  if (!isAbsolute(authFile)) throw new Error("Set PI_AUTH_FILE to an absolute credentials-file path");
  const auth = AuthStorage.create(authFile);
  await auth.login("openai-codex", callbacks);
  if (auth.drainErrors().length || auth.get("openai-codex")?.type !== "oauth") throw new Error("Credentials could not be saved");
}

export function gatewayTools(tools: GatewayTool[], gateway: ToolGateway, identity: Omit<ToolCall, "tool" | "args">): ToolDefinition[] {
  if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error("Duplicate tool name");
  return tools.map(tool => ({ ...tool, execute: async (_id, params, signal) => {
    if (signal?.aborted) throw new Error("Execution stopped");
    const result = await gateway.dispatch({ ...identity, tool: tool.name, args: params as Record<string, unknown> });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { status: result.status } };
  } }));
}

type LiveSession = { session: AgentSession; context: PiTaskContext; runId: string; sinks: Set<(e: RuntimeEvent) => void>; started: boolean; stopped: boolean };
export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly sessions = new Map<string, LiveSession>();
  constructor(private readonly options: {
    config: PiConfig;
    tools: GatewayTool[];
    gateway: ToolGateway;
    /** Loads the scheduler's authoritative execution context, including brokered input content. */
    taskContext(req: AgentRunRequest): Promise<PiTaskContext>;
    trace?(record: PiTraceRecord): Promise<void>;
  }) {}
  async startTask(req: AgentRunRequest): Promise<{ sessionId: string }> {
    const context = await this.options.taskContext(req);
    const { config } = this.options;
    const { authStorage, modelRegistry, model } = piModelRegistry(config);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false });
    const resourceLoader = new DefaultResourceLoader({ cwd: context.cwd, agentDir: config.agentDir, settingsManager,
      ...(context.systemPrompt ? { systemPromptOverride: () => context.systemPrompt } : {}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const tools = gatewayTools(this.options.tools, this.options.gateway, {
      runId: req.runId, taskId: req.taskId, agentId: req.agentId, executionId: context.executionId, traceId: context.traceId,
    });
    const { session } = await createAgentSession({ cwd: context.cwd, agentDir: config.agentDir, model: { ...model, baseUrl: config.baseUrl }, modelRegistry, authStorage,
      settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(context.cwd),
      noTools: "builtin", tools: tools.map(t => t.name), customTools: tools });
    if (session.getActiveToolNames().some(name => !tools.some(t => t.name === name))) { session.dispose(); throw new Error("Unmediated Pi tool enabled"); }
    this.sessions.set(session.sessionId, { session, context, runId: req.runId, sinks: new Set(), started: false, stopped: false });
    return { sessionId: session.sessionId };
  }
  subscribe(sessionId: string, sink: (event: RuntimeEvent) => void): () => void {
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error("Unknown session");
    live.sinks.add(sink);
    // Start only after subscription: no output can race the scheduler's registration.
    if (!live.started) { live.started = true; queueMicrotask(() => { void this.drive(live); }); }
    return () => { live.sinks.delete(sink); };
  }
  async requestStop(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (live) { live.stopped = true; await live.session.abort(); }
  }
  private async drive(live: LiveSession): Promise<void> {
    const emit = (event: RuntimeEvent) => { for (const sink of live.sinks) sink(event); };
    let timedOut = false;
    let text = "";
    let failed = false;
    let providerFailure = "ERROR";
    const started = performance.now();
    const trace = this.options.trace ?? (this.options.config.traceDirectory ? privatePiTraceWriter(this.options.config.traceDirectory) : undefined);
    let traces = Promise.resolve();
    const record = (kind: PiTraceRecord["kind"], data: unknown) => {
      if (trace) traces = traces.then(() => trace({ at: new Date().toISOString(), runId: live.runId, executionId: live.context.executionId, sessionId: live.session.sessionId, kind, data }));
      // Attach immediately: observer failure is surfaced when the trace queue is drained.
      void traces.catch(() => {});
    };
    const unsubscribe = live.session.subscribe(event => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") record("tool", event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") { failed = true; providerFailure = providerFailureCode(event.message.errorMessage); }
        text = event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      }
    });
    const timer = setTimeout(() => { timedOut = true; live.stopped = true; void live.session.abort(); }, this.options.config.timeoutMs);
    try {
      if (live.stopped) throw new Error("Stopped");
      record("prompt", { provider: this.options.config.provider, model: this.options.config.model, baseUrl: this.options.config.baseUrl, text: live.context.prompt });
      await traces;
      await live.session.prompt(live.context.prompt, { expandPromptTemplates: false });
      if (live.stopped || failed || !text) throw new Error("No successful output");
      record("completed", { ok: true, elapsedMs: performance.now() - started, statistics: live.session.getSessionStats() });
      await traces;
      emit({ kind: "output", name: live.context.outputName, content: text });
      emit({ kind: "finished", ok: true });
    } catch {
      record("completed", { ok: false, elapsedMs: performance.now() - started, statistics: live.session.getSessionStats() });
      await traces.catch(() => {});
      emit({ kind: "finished", ok: false, error: timedOut ? "TIMEOUT" : live.stopped ? "STOPPED" : providerFailure });
    }
    finally { clearTimeout(timer); unsubscribe(); live.session.dispose(); this.sessions.delete(live.session.sessionId); }
  }
}

/** Binds one adapter to one scheduler execution; caller-supplied identities cannot replace it. */
export function piRuntimeForExecution(input: {
  context: { runId: string; task: { id: string; agentId: string; title: string }; executionId: string; traceId: string; inputVersionIds: string[]; inputs: { content: string | Uint8Array; classification: string; versionId?: string; name?: string; kind?: "source" | "artifact"; declaredTrust?: "TRUSTED" | "UNTRUSTED"; securityState?: string }[]; produces: string; capabilities: string[] };
  cwd: string; config: PiConfig; tools: GatewayTool[]; gateway: ToolGateway;
}): PiRuntimeAdapter {
  const { context } = input;
  return new PiRuntimeAdapter({ config: input.config, tools: input.tools, gateway: input.gateway, taskContext: async req => {
    if (req.runId !== context.runId || req.taskId !== context.task.id || req.agentId !== context.task.agentId || JSON.stringify(req.inputArtifactIds) !== JSON.stringify(context.inputVersionIds) || JSON.stringify(req.capabilities) !== JSON.stringify(context.capabilities)) throw new Error("Runtime request does not match scheduled execution");
    return { executionId: context.executionId, traceId: context.traceId, cwd: input.cwd, outputName: context.produces,
      prompt: JSON.stringify({ task: context.task.title, inputs: context.inputs.map(i => ({ versionId: i.versionId, name: i.name, kind: i.kind, declaredTrust: i.declaredTrust, securityState: i.securityState, classification: i.classification, content: typeof i.content === "string" ? i.content : new TextDecoder().decode(i.content) })) }) };
  } });
}
