/**
 * @bastion/orchestrator — owner: Member 2
 * DAG scheduler. Implements the Scheduler port.
 * See TEAM_PLAN.md and packages/contracts/src/ports.ts.
 */
import { TaskSpec, WorkflowDefinition, newId } from "@bastion/contracts";
import type { AgentRuntimeAdapter, ArtifactBroker, Classification, EventJournal, RunSnapshot, RuntimeEvent, Scheduler, TaskState } from "@bastion/contracts";

export function schedulerParallelismFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SCHEDULER_PARALLELISM);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Missing or invalid SCHEDULER_PARALLELISM");
  return value;
}

export type ExecutionContext = { runId: string; task: TaskSpec; executionId: string; traceId: string; inputVersionIds: string[]; inputs: { content: string | Uint8Array; classification: Classification }[]; produces: string; capabilities: string[] };
type Attempt = { task: TaskSpec; executionId: string; attempt: number; state: TaskState; held: boolean; outputId?: string; sessionId?: string; runtime?: AgentRuntimeAdapter; done?: Promise<void>; /** executed before a controller restart */ executed?: boolean };
type RunWork = { definition: WorkflowDefinition; attempts: Map<string, Attempt>; driving?: Promise<void> };
export class WorkflowScheduler implements Scheduler {
  private readonly runs = new Map<string, RunWork>();
  private readonly starting = new Set<string>();
  private readonly recovering = new Set<string>();
  private readonly listeners = new Set<(e: { runId: string; taskId: string; executionId: string; ok: boolean }) => void>();
  constructor(private readonly options: {
    journal: EventJournal; broker: ArtifactBroker; parallelism: number;
    /** Must return the run's PINNED definition, not the registry's latest version. */
    workflowForRun(runId: string): Promise<WorkflowDefinition>;
    runtime(context: ExecutionContext): Promise<AgentRuntimeAdapter>;
    /** Controller-owned checks, after model completion and before publishing success. */
    verifyExecution?(context: ExecutionContext): Promise<boolean>;
    workspaceForRun(runId: string): Promise<string>;
    withExecutionFence<T>(executionId: string, operation: () => Promise<T>): Promise<T>;
  }) {
    if (!Number.isSafeInteger(options.parallelism) || options.parallelism <= 0) throw new Error("Invalid parallelism");
  }
  async start(runId: string, tasks: TaskSpec[]): Promise<void> {
    if (this.runs.has(runId) || this.starting.has(runId)) throw new Error("Run already scheduled");
    this.starting.add(runId);
    try { await this.startRun(runId, tasks); }
    finally { this.starting.delete(runId); }
  }
  private async startRun(runId: string, tasks: TaskSpec[]): Promise<void> {
    const definition = WorkflowDefinition.parse(await this.options.workflowForRun(runId));
    if (tasks.length !== definition.tasks.length || new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error("Task set does not match pinned workflow");
    const attempts = new Map<string, Attempt>();
    for (const task of tasks) {
      TaskSpec.parse(task);
      const declared = definition.tasks.find(t => t.id === task.id);
      const agent = definition.agents.find(a => a.id === task.agentId);
      if (!declared || !agent || task.runId !== runId || task.agentId !== declared.agentId || task.role !== agent.role || task.title !== declared.title || JSON.stringify(task.declaredDeps) !== JSON.stringify(declared.declaredDeps) || JSON.stringify(task.retryPolicy) !== JSON.stringify(declared.retryPolicy) || task.sourceIds.length !== declared.sourceNames.length) throw new Error("Task does not match pinned workflow");
      const expectedSources = await Promise.all(declared.sourceNames.map(name => this.options.broker.latestUsableSource(runId, name)));
      if (expectedSources.some((s, i) => !s || s.id !== task.sourceIds[i])) throw new Error("Task sources do not match workflow");
      attempts.set(task.id, { task: structuredClone(task), executionId: newId("exec"), attempt: 1, state: "PENDING", held: false });
    }
    const work: RunWork = { definition, attempts };
    this.runs.set(runId, work);
    await this.options.journal.append(runId, [{ runId, traceId: newId("trace"), type: "run.planned", payload: { tasks: tasks.map(t => ({ taskId: t.id, agentId: t.agentId, role: t.role, title: t.title, declaredDeps: t.declaredDeps, sourceIds: t.sourceIds, retryPolicy: t.retryPolicy })) } }]);
    await this.drive(runId, work);
  }
  async adopt(runId: string, snapshot: RunSnapshot): Promise<void> {
    if (this.runs.has(runId)) return;
    const definition = WorkflowDefinition.parse(await this.options.workflowForRun(runId));
    const attempts = new Map<string, Attempt>();
    for (const task of Object.values(snapshot.tasks)) {
      const exId = snapshot.latestExecutionByTask[task.id];
      const ex = exId ? snapshot.executions[exId] : undefined;
      if (!ex) { attempts.set(task.id, { task: structuredClone(task), executionId: newId("exec"), attempt: 1, state: "PENDING", held: true }); continue; }
      const output = Object.values(snapshot.artifacts).filter(a => a.producerExecutionId === ex.id).sort((a, b) => b.version - a.version)[0];
      attempts.set(task.id, { task: structuredClone(task), executionId: ex.id, attempt: ex.attempt, state: ex.state, held: ex.state !== "SUCCEEDED" && ex.state !== "FAILED",
        executed: ex.sessionId !== null || ex.state === "SUCCEEDED" || ex.state === "FAILED", ...(output ? { outputId: output.id } : {}) });
    }
    this.runs.set(runId, { definition, attempts });
  }
  onTaskSettled(listener: (e: { runId: string; taskId: string; executionId: string; ok: boolean }) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async hold(runId: string, taskIds: string[], reason: string): Promise<{ heldExecutionIds: string[] }> {
    const work = this.get(runId);
    const selected = taskIds.map(id => this.attempt(work, id));
    const heldExecutionIds: string[] = [];
    for (const attempt of selected) {
      await this.options.withExecutionFence(attempt.executionId, async () => {
        attempt.held = true;
        if (attempt.state !== "SUCCEEDED" && attempt.state !== "FAILED" && attempt.state !== "PAUSED") {
          await this.transition(runId, attempt, "PAUSED", reason);
          heldExecutionIds.push(attempt.executionId);
        }
      });
    }
    await Promise.all(selected.map(async a => { if (a.sessionId && a.runtime) await a.runtime.requestStop(a.sessionId); }));
    await Promise.all(selected.map(a => a.done));
    return { heldExecutionIds };
  }
  async rerun(runId: string, taskIds: string[], replacementSourceVersionId: string): Promise<void> {
    if (this.recovering.has(runId)) throw new Error("Recovery already running");
    this.recovering.add(runId);
    try { await this.rerunTasks(runId, taskIds, replacementSourceVersionId); }
    finally { this.recovering.delete(runId); }
  }
  private async rerunTasks(runId: string, taskIds: string[], replacementSourceVersionId: string): Promise<void> {
    const work = this.get(runId);
    if (new Set(taskIds).size !== taskIds.length) throw new Error("Duplicate rerun task");
    if (!await this.options.broker.isUsable(replacementSourceVersionId)) throw new Error("Replacement source is unusable");
    const selected = taskIds.map(id => this.attempt(work, id));
    const order = new Map(taskIds.map((id, i) => [id, i]));
    // An attempt that never executed (held before it started) is resumed, not retried.
    const neverRan = (a: Attempt) => !a.done && !a.sessionId && !a.executed;
    for (const a of selected) {
      if (a.task.declaredDeps.some(dep => order.has(dep) && order.get(dep)! >= order.get(a.task.id)!)) throw new Error("Rerun order is not topological");
      if (!neverRan(a) && (a.attempt >= a.task.retryPolicy.maxAttempts || !a.task.retryPolicy.idempotent)) throw new Error("Retry policy forbids rerun");
    }
    await this.hold(runId, taskIds, "Recovery rerun");
    if (work.driving) await work.driving;
    // Swap only inputs that are no longer usable (quarantined) for the approved replacement,
    // which may be a different logical source (e.g. a trusted fallback). Unrelated inputs stay.
    const replacements = new Map<string, string[]>();
    let found = false;
    for (const a of selected) {
      const ids = await Promise.all(a.task.sourceIds.map(async id => (await this.options.broker.isUsable(id)) ? id : replacementSourceVersionId));
      found ||= ids.includes(replacementSourceVersionId);
      replacements.set(a.task.id, ids);
    }
    if (!found) throw new Error("Replacement does not replace any quarantined input of the rerun tasks");
    for (const a of selected) {
      const task = { ...a.task, sourceIds: replacements.get(a.task.id)! };
      work.attempts.set(a.task.id, neverRan(a)
        ? { task, executionId: a.executionId, attempt: a.attempt, state: a.state, held: false }
        : { task, executionId: newId("exec"), attempt: a.attempt + 1, state: "PENDING", held: false });
    }
    await this.drive(runId, work);
  }
  private get(runId: string): RunWork { const work = this.runs.get(runId); if (!work) throw new Error("Unknown scheduled run"); return work; }
  private attempt(work: RunWork, id: string): Attempt { const a = work.attempts.get(id); if (!a) throw new Error("Unknown task"); return a; }
  private async transition(runId: string, a: Attempt, to: TaskState, reason?: string): Promise<void> {
    await this.options.journal.append(runId, [{ runId, taskId: a.task.id, agentId: a.task.agentId, traceId: newId("trace"), type: "task.state_changed", payload: { taskId: a.task.id, executionId: a.executionId, attempt: a.attempt, from: a.state, to, ...(reason ? { reason } : {}) } }]);
    a.state = to;
  }
  private drive(runId: string, work: RunWork): Promise<void> {
    if (work.driving) return work.driving;
    work.driving = this.pump(runId, work).finally(() => { work.driving = undefined; });
    return work.driving;
  }
  private async pump(runId: string, work: RunWork): Promise<void> {
    const active = new Set<Promise<void>>();
    try {
      while (true) {
        for (const a of work.attempts.values()) {
          if (active.size >= this.options.parallelism) break;
          // PAUSED-without-execution = held before it ever started; it may resume.
          if ((a.state !== "PENDING" && a.state !== "PAUSED") || a.held || a.done) continue;
          const deps = a.task.declaredDeps.map(id => this.attempt(work, id));
          if (deps.some(d => d.state !== "SUCCEEDED" || d.held || !d.outputId)) continue;
          const inputIds = [...a.task.sourceIds, ...deps.map(d => d.outputId!)];
          if (!(await Promise.all(inputIds.map(id => this.options.broker.isUsable(id)))).every(Boolean)) continue;
          if (a.held) continue;
          const done = this.execute(runId, work, a, inputIds);
          a.done = done;
          active.add(done);
          void done.finally(() => active.delete(done)).catch(() => {});
        }
        if (!active.size) break;
        await Promise.race(active);
      }
    } finally { await Promise.allSettled(active); }
  }
  private async execute(runId: string, work: RunWork, a: Attempt, inputVersionIds: string[]): Promise<void> {
    const traceId = newId("trace");
    const envelope = { runId, traceId, taskId: a.task.id, agentId: a.task.agentId };
    let unsubscribe: (() => void) | undefined;
    let ok = false;
    let reason: "COMPLETED" | "STOPPED" | "ERROR" | "TIMEOUT" = "ERROR";
    try {
      await this.options.withExecutionFence(a.executionId, async () => {
        if (a.held) return;
        await this.transition(runId, a, "READY");
        await this.transition(runId, a, "RUNNING");
      });
      if (a.held) return;
      const inputs = await Promise.all(inputVersionIds.map(id => this.options.broker.consume({ runId, inputVersionId: id, consumerExecutionId: a.executionId, consumerTaskId: a.task.id, traceId })));
      const declared = work.definition.tasks.find(t => t.id === a.task.id)!;
      const agent = work.definition.agents.find(agent => agent.id === a.task.agentId)!;
      const context = { runId, task: a.task, executionId: a.executionId, traceId, inputVersionIds, inputs, produces: declared.produces, capabilities: agent.capabilities };
      a.runtime = await this.options.runtime(context);
      const { sessionId } = await a.runtime.startTask({ runId, taskId: a.task.id, agentId: a.task.agentId, inputArtifactIds: inputVersionIds, capabilities: agent.capabilities, workspaceId: await this.options.workspaceForRun(runId) });
      a.sessionId = sessionId;
      await this.options.journal.append(runId, [{ ...envelope, type: "agent.session_started", payload: { agentId: a.task.agentId, role: a.task.role, executionId: a.executionId, sessionId } }]);
      const outputs: Extract<RuntimeEvent, { kind: "output" }>[] = [];
      const finish = new Promise<Extract<RuntimeEvent, { kind: "finished" }>>(resolve => {
        unsubscribe = a.runtime!.subscribe(sessionId, event => { if (event.kind === "output") outputs.push(event); if (event.kind === "finished") resolve(event); });
      });
      if (a.held) await a.runtime.requestStop(sessionId);
      const result = await finish;
      reason = a.held ? "STOPPED" : result.error === "TIMEOUT" ? "TIMEOUT" : result.ok ? "COMPLETED" : "ERROR";
      if (!a.held && result.ok && outputs.length === 1 && outputs[0]!.name === declared.produces && work.definition.acceptanceChecks?.some(check => check.kind === "TOOL" && check.taskId === a.task.id)) {
        if (!this.options.verifyExecution || !await this.options.verifyExecution(context)) throw new Error("Tool acceptance checks failed");
      }
      await this.options.withExecutionFence(a.executionId, async () => {
        if (a.held) return;
        if (!result.ok || outputs.length !== 1 || outputs[0]!.name !== declared.produces) throw new Error("Runtime did not produce the declared output");
        if (!(await Promise.all(inputVersionIds.map(id => this.options.broker.isUsable(id)))).every(Boolean)) throw new Error("Input quarantined before publication");
        const classification: Classification = inputs.some(i => i.classification === "SYNTHETIC_SECRET") ? "SYNTHETIC_SECRET" : inputs.some(i => i.classification === "INTERNAL") ? "INTERNAL" : "PUBLIC";
        const artifact = await this.options.broker.publish({ runId, name: declared.produces, producerExecutionId: a.executionId, producerTaskId: a.task.id, content: outputs[0]!.content, classification, traceId });
        a.outputId = artifact.id;
        await this.transition(runId, a, "SUCCEEDED");
        ok = true;
      });
    } catch {
      reason = a.held ? "STOPPED" : "ERROR";
      await this.options.withExecutionFence(a.executionId, async () => { if (!a.held) await this.transition(runId, a, "FAILED", "Execution failed"); });
    } finally {
      unsubscribe?.();
      if (a.sessionId) await this.options.journal.append(runId, [{ ...envelope, type: "agent.session_ended", payload: { agentId: a.task.agentId, executionId: a.executionId, sessionId: a.sessionId, reason } }]);
      for (const listener of this.listeners) listener({ runId, taskId: a.task.id, executionId: a.executionId, ok });
    }
  }
}
