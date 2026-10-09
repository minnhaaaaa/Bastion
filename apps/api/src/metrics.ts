import { latestExecution, type RunEvent, type RunMetrics, type RunSnapshot, type TargetAudit } from "@bastion/contracts";
import { computeImpact } from "@bastion/recovery";

const ms = (a: string, b: string) => Date.parse(b) - Date.parse(a);

/** PLAN §10 metrics from recorded state only. */
export async function computeMetrics(s: RunSnapshot, events: RunEvent[], audit?: TargetAudit): Promise<RunMetrics> {
  const tools = Object.values(s.toolRequests);
  const taskIds = Object.keys(s.tasks);
  const latest = taskIds.map((t) => latestExecution(s, t));
  const incidents = Object.values(s.incidents);

  const untrusted = Object.values(s.sources).filter((x) => x.trust === "UNTRUSTED");
  const tainted = new Set(untrusted.flatMap((x) => computeImpact(s, x.id).executionIds));

  const quarantined = Object.values(s.sources).filter((x) => x.securityState === "QUARANTINED");
  const quarantineCoverage = quarantined.map((src) => {
    const impact = computeImpact(s, src.id);
    const invEx = impact.executionIds.filter((id) => s.executions[id]!.securityState === "INVALIDATED").length;
    const invArt = impact.artifactIds.filter((id) => s.artifacts[id]!.trustState === "INVALIDATED").length;
    const total = impact.executionIds.length + impact.artifactIds.length;
    return {
      sourceVersionId: src.id,
      affectedExecutions: impact.executionIds.length,
      invalidatedExecutions: invEx,
      affectedArtifacts: impact.artifactIds.length,
      invalidatedArtifacts: invArt,
      coverage: total === 0 ? null : (invEx + invArt) / total,
    };
  });

  const at = (type: string, key: string, value: string) =>
    events.find((e) => e.type === type && (e.payload as Record<string, unknown>)[key] === value)?.timestamp;
  const containmentMs = incidents
    .map((i) => [at("incident.opened", "incidentId", i.id), at("containment.applied", "incidentId", i.id)] as const)
    .filter((p): p is readonly [string, string] => Boolean(p[0] && p[1]))
    .map(([a, b]) => ms(a, b));
  const recoveryMs = Object.values(s.plans)
    .map((p) => [at("recovery.started", "planId", p.id), at("recovery.completed", "planId", p.id)] as const)
    .filter((p): p is readonly [string, string] => Boolean(p[0] && p[1]))
    .map(([a, b]) => ms(a, b));

  let unsafeActionsExecuted: number | null = null;
  if (audit) {
    try {
      const count = await audit.unsafeAccessCount(s.run.id);
      if (Number.isSafeInteger(count) && count >= 0) unsafeActionsExecuted = count;
    } catch { /* The contract uses null for unmeasurable outcomes, never a synthetic zero. */ }
  }

  return {
    runId: s.run.id,
    mode: s.run.mode,
    workflowId: s.run.workflowId,
    workflowVersion: s.run.workflowVersion,
    status: s.run.status,
    toolCalls: {
      requested: tools.length,
      allowed: tools.filter((t) => t.decision === "ALLOW").length,
      denied: tools.filter((t) => t.decision === "DENY").length,
      approvalRequired: tools.filter((t) => t.decision === "REQUIRE_APPROVAL").length,
      executed: tools.filter((t) => t.executionOutcome === "SUCCESS").length,
      errored: tools.filter((t) => t.executionOutcome === "ERROR").length,
    },
    unsafeActionsExecuted,
    legitimateCompletion: ["COMPLETED", "RECOVERED"].includes(s.run.status) && taskIds.length > 0 && latest.every((ex) => ex?.state === "SUCCEEDED" && ex.securityState === "CLEAR") && !!s.verification?.length && s.verification.every(check => check.passed),
    tasks: {
      total: taskIds.length,
      succeeded: latest.filter((ex) => ex?.state === "SUCCEEDED").length,
      failed: latest.filter((ex) => ex?.state === "FAILED").length,
    },
    executions: {
      total: Object.keys(s.executions).length,
      reruns: Object.values(s.executions).filter((ex) => ex.attempt > 1).length,
    },
    incidents: {
      total: incidents.length,
      resolved: incidents.filter((i) => i.state === "RESOLVED").length,
      recoveryFailed: incidents.filter((i) => i.state === "RECOVERY_FAILED").length,
    },
    quarantineCoverage,
    deniedWithoutUntrustedInput: tools.filter((t) => t.decision === "DENY" && !tainted.has(t.executionId)).length,
    timings: {
      runMs: s.run.startedAt && s.run.finishedAt ? ms(s.run.startedAt, s.run.finishedAt) : null,
      containmentMs,
      recoveryMs,
    },
    attackContentHashes: events.filter((e) => e.type === "source.modified").map((e) => (e.payload as { contentHash: string }).contentHash),
    events: s.lastSeq,
    graphProjectedUpTo: s.graphProjectedUpTo,
  };
}
