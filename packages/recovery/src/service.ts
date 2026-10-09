import { createHash } from "node:crypto";
import {
  newId,
  type GraphProjector,
  type NewRunEvent,
  type RecoveryPlan,
  type RecoveryService,
  type RecoveryVerifier,
  type RunEvent,
  type RunSnapshot,
  type Scheduler,
  type SecurityIncident,
  type Severity,
  type Workflow,
} from "@bastion/contracts";
import { computeImpact, topoOrder, upstreamUntrustedSources } from "./impact";

export type RecoveryErrorCode = "NOT_FOUND" | "CONFLICT" | "FORBIDDEN" | "EXPIRED" | "UNAVAILABLE" | "VALIDATION";
export class RecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode, message: string) {
    super(message);
  }
}

export interface RecoveryDeps {
  journal: {
    append(runId: string, events: NewRunEvent[]): Promise<RunEvent[]>;
    snapshot(runId: string): Promise<RunSnapshot | null>;
    onCommitted(listener: (e: RunEvent) => void | Promise<void>): () => void;
  };
  locate: {
    runOfIncident(incidentId: string): Promise<string | null>;
    runOfApproval(approvalId: string): Promise<string | null>;
  };
  workflows: { getVersion(id: string, version: number): Promise<Workflow | null> };
  /** Member 2. Absent until the runtime is wired: quarantine still works, rerun is unavailable. */
  scheduler?: Scheduler;
  /** Member 2. Required to declare a recovery successful. */
  verifier?: RecoveryVerifier;
  /** Member 3 knowledge graph. Optional cross-check; never the sole basis for containment. */
  graph?: GraphProjector;
  approvalTtlMs: number;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

/** Actors allowed to quarantine/approve: authenticated humans (operators or arena players). Never agents. */
const isHuman = (actorId: string) => actorId.startsWith("user_") || actorId.startsWith("player_");

const digestOf = (plan: Omit<RecoveryPlan, "planDigest"> & { runId: string }) =>
  "sha256:" +
  createHash("sha256")
    .update(
      JSON.stringify([plan.id, plan.runId, plan.incidentId, plan.rerunTaskIds, plan.preservedTaskIds, plan.replacementSourceVersionId]),
    )
    .digest("hex");

type ActiveRecovery = { incidentId: string; planId: string; pending: Set<string>; priorExecutions: Set<string> };

/**
 * Incident manager + containment + recovery planner (ARCHITECTURE §6.2–6.3).
 * All decisions are made from the authoritative Postgres-backed snapshot.
 */
export class RecoveryManager implements RecoveryService {
  private readonly active = new Map<string, ActiveRecovery>();
  private readonly now: () => Date;
  private readonly log: (msg: string, extra?: unknown) => void;
  private unsubscribers: (() => void)[] = [];
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly d: RecoveryDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
  }

  /** Subscribe to the journal (auto-incidents) and scheduler (recovery completion). */
  start(): void {
    this.unsubscribers.push(this.d.journal.onCommitted((e) => this.onEvent(e)));
    if (this.d.scheduler) this.unsubscribers.push(this.d.scheduler.onTaskSettled((e) => this.track(this.onTaskSettled(e))));
  }

  stop(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  /** Resolves when all background completion work has finished (shutdown, tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<unknown>): void {
    const t = p.catch((err) => this.log("recovery background task failed", err)).finally(() => this.inflight.delete(t));
    this.inflight.add(t);
  }

  private async snap(runId: string): Promise<RunSnapshot> {
    const s = await this.d.journal.snapshot(runId);
    if (!s) throw new RecoveryError("NOT_FOUND", `run ${runId} not found`);
    return s;
  }

  private async incidentCtx(incidentId: string) {
    const runId = await this.d.locate.runOfIncident(incidentId);
    if (!runId) throw new RecoveryError("NOT_FOUND", `incident ${incidentId} not found`);
    const s = await this.snap(runId);
    const incident = s.incidents[incidentId];
    if (!incident) throw new RecoveryError("NOT_FOUND", `incident ${incidentId} not found`);
    return { runId, s, incident };
  }

  // ── Incidents ────────────────────────────────────────────────────────────
  async openIncident(input: {
    runId: string;
    sourceVersionId: string;
    severity: Severity;
    reason: string;
    triggerToolRequestId: string | null;
  }): Promise<SecurityIncident> {
    const s = await this.snap(input.runId);
    if (!s.sources[input.sourceVersionId]) throw new RecoveryError("NOT_FOUND", `source ${input.sourceVersionId} not in run`);
    const existing = Object.values(s.incidents).find(
      (i) => i.sourceVersionId === input.sourceVersionId && i.state !== "RESOLVED" && i.state !== "RECOVERY_FAILED",
    );
    if (existing) return existing;
    const incidentId = newId("incident");
    await this.d.journal.append(input.runId, [
      {
        runId: input.runId,
        traceId: newId("trace"),
        type: "incident.opened",
        payload: { incidentId, sourceVersionId: input.sourceVersionId, severity: input.severity, reason: input.reason, triggerToolRequestId: input.triggerToolRequestId },
      },
    ]);
    return (await this.snap(input.runId)).incidents[incidentId]!;
  }

  private async onEvent(e: RunEvent): Promise<void> {
    if (e.type !== "tool.decided" || e.payload.decision !== "DENY") return;
    const s = await this.snap(e.runId);
    const req = s.toolRequests[e.payload.toolRequestId];
    if (!req) return;
    for (const srcId of upstreamUntrustedSources(s, req.executionId)) {
      const src = s.sources[srcId]!;
      await this.openIncident({
        runId: e.runId,
        sourceVersionId: srcId,
        severity: "HIGH",
        reason: `${req.toolName} on ${req.destination ?? req.resource} denied by ${e.payload.ruleId}; the requesting execution consumed untrusted ${src.name} v${src.version}`,
        triggerToolRequestId: req.id,
      });
    }
  }

  // ── Containment ──────────────────────────────────────────────────────────
  async quarantine(incidentId: string, sourceVersionId: string, actorId: string): Promise<void> {
    if (!isHuman(actorId)) throw new RecoveryError("FORBIDDEN", "only an authenticated human can quarantine");
    const { runId, s, incident } = await this.incidentCtx(incidentId);
    if (incident.sourceVersionId !== sourceVersionId) throw new RecoveryError("VALIDATION", "source does not match the incident");
    if (incident.state !== "OPEN") throw new RecoveryError("CONFLICT", `incident is ${incident.state}`);
    const traceId = newId("trace");
    const src = s.sources[sourceVersionId]!;

    // 1. Synchronously mark the source quarantined in the authoritative store. From this commit on,
    //    the broker refuses it and the gateway's dispatch-time re-check denies dependents.
    await this.d.journal.append(runId, [
      { runId, traceId, type: "incident.quarantined", payload: { incidentId, sourceVersionId, actorId } },
      { runId, traceId, type: "source.security_state_changed", payload: { sourceVersionId, from: src.securityState, to: "QUARANTINED", incidentId } },
    ]);

    // 2. Impact closure from Postgres (authoritative). Cross-check with the graph only if it is caught up.
    const after = await this.snap(runId);
    const impact = computeImpact(after, sourceVersionId);
    let graphConfirmed = false;
    if (this.d.graph) {
      try {
        if ((await this.d.graph.projectedUpTo(runId)) >= s.lastSeq) {
          const g = await this.d.graph.impactSet(runId, sourceVersionId);
          for (const t of g.taskIds) if (!impact.taskIds.includes(t)) impact.taskIds.push(t);
          for (const a of g.artifactIds) if (!impact.artifactIds.includes(a)) impact.artifactIds.push(a);
          graphConfirmed = true;
        }
      } catch (err) {
        this.log("graph cross-check failed; using authoritative closure only", err);
      }
    }

    // 3. Stop scheduling affected work and hold active executions.
    const held = this.d.scheduler ? await this.d.scheduler.hold(runId, impact.taskIds, `incident ${incidentId}`) : { heldExecutionIds: [] };

    // 4. Invalidate affected outputs and record the containment.
    const latest = await this.snap(runId);
    const batch: NewRunEvent[] = [];
    for (const execId of impact.executionIds) {
      const ex = latest.executions[execId]!;
      if (ex.securityState !== "INVALIDATED")
        batch.push({ runId, traceId, taskId: ex.taskId, type: "task.security_state_changed", payload: { taskId: ex.taskId, executionId: ex.id, from: ex.securityState, to: "INVALIDATED", incidentId } });
    }
    for (const artId of impact.artifactIds) {
      const a = latest.artifacts[artId]!;
      if (a.trustState !== "INVALIDATED")
        batch.push({ runId, traceId, type: "artifact.trust_changed", payload: { artifactVersionId: a.id, from: a.trustState, to: "INVALIDATED", incidentId } });
    }
    batch.push({
      runId,
      traceId,
      type: "containment.applied",
      payload: {
        incidentId,
        affectedTaskIds: impact.taskIds,
        invalidatedArtifactIds: impact.artifactIds,
        heldExecutionIds: held.heldExecutionIds,
        // Postgres closure is authoritative; "widened" flags that the graph could not confirm it.
        widened: !graphConfirmed,
      },
    });
    if (latest.run.status !== "CONTAINED")
      batch.push({ runId, traceId, type: "run.status_changed", payload: { from: latest.run.status, to: "CONTAINED", reason: `incident ${incidentId} quarantined` } });
    await this.d.journal.append(runId, batch);
  }

  // ── Recovery planning ────────────────────────────────────────────────────
  /** Trusted fallback for the incident's source, as declared in the run's workflow definition. */
  async suggestReplacement(incidentId: string): Promise<string | null> {
    const { s, incident } = await this.incidentCtx(incidentId);
    const wf = await this.d.workflows.getVersion(s.run.workflowId, s.run.workflowVersion);
    const name = s.sources[incident.sourceVersionId]?.name;
    const fallback = wf?.definition.sources.find((x) => x.name === name)?.fallbackSourceName;
    if (!fallback) return null;
    const candidates = Object.values(s.sources)
      .filter((x) => x.name === fallback && x.trust === "TRUSTED" && x.securityState === "CLEAR")
      .sort((a, b) => b.version - a.version);
    return candidates[0]?.id ?? null;
  }

  async plan(incidentId: string, replacementSourceVersionId: string): Promise<RecoveryPlan> {
    const { runId, s, incident } = await this.incidentCtx(incidentId);
    if (incident.state !== "QUARANTINED" && incident.state !== "RECOVERY_PLANNED")
      throw new RecoveryError("CONFLICT", `incident is ${incident.state}; quarantine before planning`);
    const repl = s.sources[replacementSourceVersionId];
    if (!repl) throw new RecoveryError("NOT_FOUND", "replacement source not in run");
    if (repl.trust !== "TRUSTED" || repl.securityState !== "CLEAR")
      throw new RecoveryError("VALIDATION", "replacement source must be TRUSTED and CLEAR");

    const impact = computeImpact(s, incident.sourceVersionId);
    const affected = new Set(impact.taskIds);
    const rerunTaskIds = topoOrder(s, impact.taskIds);
    const preservedTaskIds = Object.keys(s.tasks).filter((t) => !affected.has(t));
    const planId = newId("plan");
    const planDigest = digestOf({ id: planId, runId, incidentId, rerunTaskIds, preservedTaskIds, replacementSourceVersionId });
    const traceId = newId("trace");

    const batch: NewRunEvent[] = [];
    // A new plan supersedes any approval still pending for this incident.
    for (const a of Object.values(s.approvals))
      if (a.incidentId === incidentId && a.status === "PENDING")
        batch.push({ runId, traceId, type: "approval.resolved", payload: { approvalId: a.id, status: "EXPIRED", actorId: "system" } });
    batch.push(
      { runId, traceId, type: "recovery.planned", payload: { incidentId, planId, rerunTaskIds, preservedTaskIds, replacementSourceVersionId, planDigest } },
      {
        runId,
        traceId,
        type: "approval.requested",
        payload: { approvalId: newId("approval"), incidentId, planId, actionDigest: planDigest, expiresAt: new Date(this.now().getTime() + this.d.approvalTtlMs).toISOString() },
      },
    );
    await this.d.journal.append(runId, batch);
    return (await this.snap(runId)).plans[planId]!;
  }

  // ── Approval + rerun ─────────────────────────────────────────────────────
  private async approvalCtx(approvalId: string, planId: string, actionDigest: string, actorId: string) {
    if (!isHuman(actorId)) throw new RecoveryError("FORBIDDEN", "only an authenticated human can approve");
    const runId = await this.d.locate.runOfApproval(approvalId);
    if (!runId) throw new RecoveryError("NOT_FOUND", "approval not found");
    const s = await this.snap(runId);
    const approval = s.approvals[approvalId]!;
    const plan = s.plans[planId];
    if (!plan || approval.planId !== planId) throw new RecoveryError("VALIDATION", "approval is not for this plan");
    if (approval.status !== "PENDING") throw new RecoveryError("CONFLICT", `approval is ${approval.status}`);
    if (actionDigest !== approval.actionDigest || actionDigest !== plan.planDigest)
      throw new RecoveryError("VALIDATION", "action digest does not match the plan you are approving");
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) {
      await this.d.journal.append(runId, [
        { runId, traceId: newId("trace"), type: "approval.resolved", payload: { approvalId, status: "EXPIRED", actorId: "system" } },
      ]);
      throw new RecoveryError("EXPIRED", "approval expired; request a new plan");
    }
    return { runId, s, approval, plan };
  }

  async reject(input: { approvalId: string; planId: string; actionDigest: string; actorId: string }): Promise<void> {
    const { runId } = await this.approvalCtx(input.approvalId, input.planId, input.actionDigest, input.actorId);
    await this.d.journal.append(runId, [
      { runId, traceId: newId("trace"), type: "approval.resolved", payload: { approvalId: input.approvalId, status: "REJECTED", actorId: input.actorId } },
    ]);
  }

  async approveAndRecover(input: { approvalId: string; planId: string; actionDigest: string; actorId: string }): Promise<void> {
    const { runId, s, plan } = await this.approvalCtx(input.approvalId, input.planId, input.actionDigest, input.actorId);
    if (!this.d.scheduler || !this.d.verifier) throw new RecoveryError("UNAVAILABLE", "agent runtime (scheduler/verifier) is not connected");
    if (this.active.has(runId)) throw new RecoveryError("CONFLICT", "a recovery is already running for this run");
    const repl = s.sources[plan.replacementSourceVersionId];
    if (!repl || repl.securityState !== "CLEAR") throw new RecoveryError("CONFLICT", "replacement source is no longer usable");

    const traceId = newId("trace");
    await this.d.journal.append(runId, [
      { runId, traceId, type: "approval.resolved", payload: { approvalId: input.approvalId, status: "APPROVED", actorId: input.actorId } },
      { runId, traceId, type: "recovery.started", payload: { incidentId: plan.incidentId, planId: plan.id } },
      { runId, traceId, type: "run.status_changed", payload: { from: s.run.status, to: "RECOVERING" } },
      // Single use: consumed the moment recovery starts.
      { runId, traceId, type: "approval.resolved", payload: { approvalId: input.approvalId, status: "CONSUMED", actorId: input.actorId } },
    ]);

    if (plan.rerunTaskIds.length === 0) return this.finish(runId, plan.incidentId, plan.id);
    this.active.set(runId, {
      incidentId: plan.incidentId,
      planId: plan.id,
      pending: new Set(plan.rerunTaskIds),
      priorExecutions: new Set(Object.keys(s.executions)),
    });
    try {
      await this.d.scheduler.rerun(runId, plan.rerunTaskIds, plan.replacementSourceVersionId);
    } catch (err) {
      this.log("scheduler.rerun failed", err);
      await this.finish(runId, plan.incidentId, plan.id, `rerun could not start: ${String(err)}`);
    }
  }

  private async onTaskSettled(e: { runId: string; taskId: string; executionId: string; ok: boolean }) {
    const rec = this.active.get(e.runId);
    if (!rec || rec.priorExecutions.has(e.executionId) || !rec.pending.has(e.taskId)) return;
    if (!e.ok) return this.finish(e.runId, rec.incidentId, rec.planId, `rerun of ${e.taskId} failed`);
    rec.pending.delete(e.taskId);
    if (rec.pending.size === 0) await this.finish(e.runId, rec.incidentId, rec.planId);
  }

  private async finish(runId: string, incidentId: string, planId: string, failure?: string) {
    this.active.delete(runId);
    let checks: { name: string; passed: boolean; detail?: string }[];
    if (failure) checks = [{ name: "rerun", passed: false, detail: failure }];
    else {
      try {
        checks = await this.d.verifier!.verify(runId, planId);
      } catch (err) {
        checks = [{ name: "verifier", passed: false, detail: String(err) }];
      }
    }
    // Never declare success without at least one real passing check.
    const ok = checks.length > 0 && checks.every((c) => c.passed);
    const s = await this.snap(runId);
    const traceId = newId("trace");
    await this.d.journal.append(runId, [
      { runId, traceId, type: "verification.completed", payload: { incidentId, checks } },
      { runId, traceId, type: "recovery.completed", payload: { incidentId, planId, outcome: ok ? "RECOVERED" : "RECOVERY_FAILED" } },
      { runId, traceId, type: "run.status_changed", payload: { from: s.run.status, to: ok ? "RECOVERED" : "RECOVERY_FAILED" } },
    ]);
  }
}
