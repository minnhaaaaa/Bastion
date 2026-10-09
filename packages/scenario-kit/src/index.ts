/**
 * @bastion/scenario-kit — owner: Member 2
 * Runs workflows loaded from the WorkflowRepository: loads sources from their configured
 * locations, applies attack payloads registered in the workflow definition, runs
 * baseline/protected modes and verifier checks. Contains no workflow data of its own.
 * See TEAM_PLAN.md and packages/contracts/src/ports.ts.
 */
import { WorkflowDefinition, newId } from "@bastion/contracts";
import type { ArtifactBroker, EventJournal, Run, RunSnapshot, Scheduler, TaskSpec, WorkflowRepository } from "@bastion/contracts";

export type VerificationCheck = { name: string; passed: boolean; detail?: string };
export class WorkflowRunner {
  private readonly starting = new Set<string>();
  constructor(private readonly options: {
    workflows: WorkflowRepository; broker: ArtifactBroker; journal: EventJournal;
    /** Loader must restrict file paths and URL destinations to the configured sandbox. */
    load(location: string): Promise<string>;
    run(runId: string): Promise<Run>;
    scheduler(mode: Run["mode"]): Scheduler;
    snapshot(runId: string): Promise<RunSnapshot>;
    /** Verifiers are trusted server code, supplied by the application, never by the model. */
    verify(snapshot: RunSnapshot): Promise<VerificationCheck[]>;
  }) {}
  private async definition(runId: string): Promise<{ run: Run; definition: WorkflowDefinition }> {
    const run = await this.options.run(runId);
    const workflow = await this.options.workflows.get(run.workflowId);
    if (!workflow || workflow.version !== run.workflowVersion) throw new Error("Pinned workflow version unavailable");
    return { run, definition: WorkflowDefinition.parse(workflow.definition) };
  }
  async start(runId: string): Promise<VerificationCheck[]> {
    if (this.starting.has(runId)) throw new Error("Workflow already running");
    this.starting.add(runId);
    try { return await this.startRun(runId); }
    catch {
      const snapshot = await this.options.snapshot(runId);
      if (snapshot.run.status === "RUNNING") await this.options.journal.append(runId, [{ runId, traceId: newId("trace"), type: "run.status_changed", payload: { from: "RUNNING", to: "FAILED", reason: "Workflow execution or verification failed" } }]);
      throw new Error("Workflow start failed");
    } finally { this.starting.delete(runId); }
  }
  private async startRun(runId: string): Promise<VerificationCheck[]> {
    const { run, definition } = await this.definition(runId);
    if (run.status !== "CREATED") throw new Error("Run already started");
    const sourceIds = new Map<string, string>();
    for (const source of definition.sources) {
      const existing = await this.options.broker.latestUsableSource(runId, source.name);
      const version = existing ?? await this.options.broker.ingestSource({ runId, name: source.name, content: await this.options.load(source.location), trust: source.trust, classification: source.classification, traceId: newId("trace") });
      sourceIds.set(source.name, version.id);
    }
    const tasks: TaskSpec[] = definition.tasks.map(task => ({ id: task.id, runId, agentId: task.agentId,
      role: definition.agents.find(a => a.id === task.agentId)!.role, title: task.title,
      declaredDeps: task.declaredDeps, sourceIds: task.sourceNames.map(name => sourceIds.get(name)!), retryPolicy: task.retryPolicy }));
    await this.options.journal.append(runId, [{ runId, traceId: newId("trace"), type: "run.status_changed", payload: { from: run.status, to: "RUNNING" } }]);
    await this.options.scheduler(run.mode).start(runId, tasks);
    const snapshot = await this.options.snapshot(runId);
    // A contained run stays contained; recovery owns its subsequent lifecycle.
    if (snapshot.run.status === "CONTAINED" || snapshot.run.status === "RECOVERING") return [];
    const allSucceeded = tasks.every(task => snapshot.executions[snapshot.latestExecutionByTask[task.id] ?? ""]?.state === "SUCCEEDED");
    const checks = allSucceeded ? await this.options.verify(snapshot) : [{ name: "workflow.execution", passed: false, detail: "Workflow tasks did not all succeed" }];
    await this.options.journal.append(runId, [
      { runId, traceId: newId("trace"), type: "verification.completed", payload: { incidentId: null, checks } },
      { runId, traceId: newId("trace"), type: "run.status_changed", payload: { from: snapshot.run.status, to: allSucceeded && checks.length > 0 && checks.every(c => c.passed) ? "COMPLETED" : "FAILED" } },
    ]);
    return checks;
  }
  async applyAttack(runId: string, attackPayloadId: string): Promise<string> {
    const { definition } = await this.definition(runId);
    const payload = definition.attackPayloads.find(p => p.id === attackPayloadId);
    if (!payload) throw new Error("Unknown workflow attack payload");
    const source = definition.sources.find(s => s.name === payload.targetSourceName)!;
    const previous = await this.options.broker.latestUsableSource(runId, source.name);
    const version = await this.options.broker.ingestSource({ runId, name: source.name, content: await this.options.load(payload.contentLocation), trust: "UNTRUSTED", classification: source.classification, ...(previous ? { previousVersionId: previous.id } : {}), traceId: newId("trace") });
    return version.id;
  }
}
