import { createHash } from "node:crypto";
import { z } from "zod";
import { newId, Severity, type EventJournal, type RunSnapshot } from "@bastion/contracts";
import { redactPreview } from "@bastion/provenance";
import type { FindingReporter } from "@bastion/runtime-pi";

const Finding = z.object({ sourceVersionId: z.string().min(1), evidence: z.string().min(8).max(500), reason: z.string().trim().min(1).max(500), severity: Severity }).strict();
type Identity = { runId: string; executionId: string; traceId: string; taskId: string; agentId: string; inputVersionIds: string[] };

/** One recorder per controller. Serialize source reports to deduplicate parallel workers. */
export function injectionFindingRecorder(journal: EventJournal & { snapshot(runId: string): Promise<RunSnapshot | null> }, content: (runId: string, versionId: string) => Promise<Uint8Array>) {
  const locks = new Map<string, Promise<unknown>>();
  return (identity: Identity): FindingReporter => async raw => {
    const finding = Finding.parse(raw);
    const key = `${identity.runId}:${finding.sourceVersionId}`;
    const previous = locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const s = await journal.snapshot(identity.runId);
      const execution = s?.executions[identity.executionId];
      const source = s?.sources[finding.sourceVersionId];
      if (!s || !source || !execution || execution.taskId !== identity.taskId || s.tasks[identity.taskId]?.agentId !== identity.agentId || s.latestExecutionByTask[identity.taskId] !== identity.executionId || execution.state !== "RUNNING" || execution.securityState !== "CLEAR") throw new Error("Report is not from a current running execution");
      if (!identity.inputVersionIds.includes(source.id) || !s.edges.some(edge => edge.relation === "CONSUMED" && edge.fromId === source.id && edge.toId === execution.id)) throw new Error("The reported source was not consumed by this execution");
      const text = new TextDecoder().decode(await content(identity.runId, source.id));
      if (!finding.evidence.trim() || !text.includes(finding.evidence)) throw new Error("Evidence must be an exact excerpt of the supplied source");
      const existing = Object.values(s.incidents).find(incident => incident.sourceVersionId === source.id && !["RESOLVED", "RECOVERY_FAILED"].includes(incident.state));
      if (existing) return { incidentId: existing.id, sourceVersionId: source.id, state: existing.state };
      const incidentId = newId("incident");
      const digest = createHash("sha256").update(finding.evidence).digest("hex");
      await journal.append(identity.runId, [{ runId: identity.runId, traceId: identity.traceId, taskId: identity.taskId, agentId: identity.agentId, type: "incident.opened", payload: {
        incidentId, sourceVersionId: source.id, severity: finding.severity, triggerToolRequestId: null,
        reason: `Model-reported prompt injection: ${redactPreview(finding.reason)} (evidence SHA-256: ${digest}; execution: ${execution.id}). Requires review; no tool denial implied.`,
      } }]);
      return { incidentId, sourceVersionId: source.id, state: "OPEN" };
    });
    locks.set(key, pending);
    try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
  };
}
