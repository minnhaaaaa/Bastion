/**
 * @bastion/runtime-pi — owner: Member 2
 * Pi-backed AgentRuntimeAdapter. All file/network/process tools must route through ToolGateway.
 * See TEAM_PLAN.md and packages/contracts/src/ports.ts.
 */
import { AuthStorage, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, createAgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { AgentRunRequest, AgentRuntimeAdapter, RuntimeEvent, ToolCall, ToolGateway } from "@bastion/contracts";

export type GatewayTool = { name: string; label: string; description: string; parameters: TSchema };
export type PiTaskContext = {
  executionId: string;
  traceId: string;
  cwd: string;
  prompt: string;
  outputName: string;
};
export type PiConfig = { provider: string; model: string; baseUrl: string; apiKey: string; agentDir: string; timeoutMs: number };
export function piConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PiConfig {
  const required = (key: string) => { const value = env[key]; if (!value?.trim()) throw new Error(`Missing ${key}`); return value; };
  const timeoutMs = Number(required("PI_TIMEOUT_MS"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid PI_TIMEOUT_MS");
  const baseUrl = required("PI_BASE_URL");
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid PI_BASE_URL");
  return { provider: required("PI_PROVIDER"), model: required("PI_MODEL"), baseUrl, apiKey: required("PI_API_KEY"), agentDir: required("PI_AGENT_DIR"), timeoutMs };
}

export function gatewayTools(tools: GatewayTool[], gateway: ToolGateway, identity: Omit<ToolCall, "tool" | "args">): ToolDefinition[] {
  if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error("Duplicate tool name");
  return tools.map(tool => ({ ...tool, execute: async (_id, params, signal) => {
    if (signal?.aborted) throw new Error("Execution stopped");
    const result = await gateway.dispatch({ ...identity, tool: tool.name, args: params as Record<string, unknown> });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { status: result.status } };
  } }));
}

type LiveSession = { session: AgentSession; context: PiTaskContext; sinks: Set<(e: RuntimeEvent) => void>; started: boolean; stopped: boolean };
export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly sessions = new Map<string, LiveSession>();
  constructor(private readonly options: {
    config: PiConfig;
    tools: GatewayTool[];
    gateway: ToolGateway;
    /** Loads the scheduler's authoritative execution context, including brokered input content. */
    taskContext(req: AgentRunRequest): Promise<PiTaskContext>;
  }) {}
  async startTask(req: AgentRunRequest): Promise<{ sessionId: string }> {
    const context = await this.options.taskContext(req);
    const { config } = this.options;
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(config.provider, config.apiKey);
    // Empty path disables models.json loading, including command-based credential resolvers.
    const modelRegistry = ModelRegistry.create(authStorage, "");
    const model = modelRegistry.find(config.provider, config.model);
    if (!model) throw new Error("Configured Pi model does not exist");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false });
    const resourceLoader = new DefaultResourceLoader({ cwd: context.cwd, agentDir: config.agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const tools = gatewayTools(this.options.tools, this.options.gateway, {
      runId: req.runId, taskId: req.taskId, agentId: req.agentId, executionId: context.executionId, traceId: context.traceId,
    });
    const { session } = await createAgentSession({ cwd: context.cwd, agentDir: config.agentDir, model: { ...model, baseUrl: config.baseUrl }, modelRegistry, authStorage,
      settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(context.cwd),
      noTools: "builtin", tools: tools.map(t => t.name), customTools: tools });
    if (session.getActiveToolNames().some(name => !tools.some(t => t.name === name))) { session.dispose(); throw new Error("Unmediated Pi tool enabled"); }
    this.sessions.set(session.sessionId, { session, context, sinks: new Set(), started: false, stopped: false });
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
    const unsubscribe = live.session.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") failed = true;
        text = event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      }
    });
    const timer = setTimeout(() => { timedOut = true; live.stopped = true; void live.session.abort(); }, this.options.config.timeoutMs);
    try {
      if (live.stopped) throw new Error("Stopped");
      await live.session.prompt(live.context.prompt, { expandPromptTemplates: false });
      if (live.stopped || failed || !text) throw new Error("No successful output");
      emit({ kind: "output", name: live.context.outputName, content: text });
      emit({ kind: "finished", ok: true });
    } catch { emit({ kind: "finished", ok: false, error: timedOut ? "TIMEOUT" : live.stopped ? "STOPPED" : "ERROR" }); }
    finally { clearTimeout(timer); unsubscribe(); live.session.dispose(); this.sessions.delete(live.session.sessionId); }
  }
}

/** Binds one adapter to one scheduler execution; caller-supplied identities cannot replace it. */
export function piRuntimeForExecution(input: {
  context: { runId: string; task: { id: string; agentId: string; title: string }; executionId: string; traceId: string; inputVersionIds: string[]; inputs: { content: string | Uint8Array; classification: string }[]; produces: string; capabilities: string[] };
  cwd: string; config: PiConfig; tools: GatewayTool[]; gateway: ToolGateway;
}): PiRuntimeAdapter {
  const { context } = input;
  return new PiRuntimeAdapter({ config: input.config, tools: input.tools, gateway: input.gateway, taskContext: async req => {
    if (req.runId !== context.runId || req.taskId !== context.task.id || req.agentId !== context.task.agentId || JSON.stringify(req.inputArtifactIds) !== JSON.stringify(context.inputVersionIds) || JSON.stringify(req.capabilities) !== JSON.stringify(context.capabilities)) throw new Error("Runtime request does not match scheduled execution");
    return { executionId: context.executionId, traceId: context.traceId, cwd: input.cwd, outputName: context.produces,
      prompt: JSON.stringify({ task: context.task.title, inputs: context.inputs.map(i => ({ classification: i.classification, content: typeof i.content === "string" ? i.content : new TextDecoder().decode(i.content) })) }) };
  } });
}
