import { newId } from "@bastion/contracts";
import type { EventJournal, RunSnapshot, ToolCall, ToolGateway } from "@bastion/contracts";
import type { VerificationCheck } from "./index";

export type SelectedClaim = { artifactVersionId: string; text: string; sourceVersionIds: string[] };

/** Exact quotation corroboration, not a semantic truth classifier. Selection is trusted workflow data. */
export async function verifySelectedClaims(input: {
  snapshot: RunSnapshot; claims: SelectedClaim[]; journal: EventJournal;
  /** Private broker/blob reader. The snapshot's membership/trust/provenance checks run first. */
  readVersion(versionId: string): Promise<string>;
  /** Must redact/classify content before returning a public preview. */
  preview(text: string): string;
}): Promise<VerificationCheck[]> {
  const { snapshot: s } = input;
  const ancestors = (executionId: string): Set<string> => {
    const found = new Set<string>(); const visited = new Set<string>(); const pending = [executionId];
    while (pending.length) {
      const execution = pending.pop()!;
      if (visited.has(execution)) continue;
      visited.add(execution);
      for (const edge of s.edges.filter(e => e.relation === "CONSUMED" && e.toId === execution)) {
        if (s.sources[edge.fromId]) found.add(edge.fromId);
        const artifact = s.artifacts[edge.fromId];
        if (artifact && artifact.trustState === "CLEAR") pending.push(artifact.producerExecutionId);
      }
    }
    return found;
  };
  const checks: VerificationCheck[] = [];
  for (const claim of input.claims) {
    const artifact = s.artifacts[claim.artifactVersionId];
    if (!artifact) throw new Error("Claim artifact is not owned by this run");
    const observed = ancestors(artifact.producerExecutionId);
    let supported = artifact.trustState === "CLEAR" && claim.text.trim().length > 0 && claim.sourceVersionIds.length > 0;
    // A quote must appear in the output and ALL explicitly cited, trusted, observed sources.
    if (supported) supported = (await input.readVersion(artifact.id)).includes(claim.text);
    for (const id of claim.sourceVersionIds) {
      const source = s.sources[id];
      if (!source || source.trust !== "TRUSTED" || source.securityState !== "CLEAR" || !observed.has(id)) { supported = false; break; }
      if (supported && !(await input.readVersion(id)).includes(claim.text)) supported = false;
    }
    if (!supported) {
      const preview = artifact.classification === "PUBLIC" ? input.preview(claim.text) : "";
      if (preview.length > 280) throw new Error("Claim preview exceeds contract limit");
      await input.journal.append(s.run.id, [{ runId: s.run.id, traceId: newId("trace"), type: "claim.unverified", payload: { artifactVersionId: artifact.id, claim: preview, reason: "Selected quotation lacks trusted observed source support" } }]);
    }
    checks.push({ name: `claim.supported:${artifact.id}`, passed: supported });
  }
  return checks;
}

export type ToolAcceptanceCheck = { id: string; call: ToolCall; expectedExit: "SUCCESS" };
/** Acceptance tool calls use the same policy gateway and an existing RUNNING verifier execution. */
export async function verifyToolAcceptanceChecks(input: { snapshot: RunSnapshot; checks: ToolAcceptanceCheck[]; gateway: ToolGateway }): Promise<VerificationCheck[]> {
  const output: VerificationCheck[] = [];
  for (const check of input.checks) {
    const s = input.snapshot; const call = check.call; const execution = s.executions[call.executionId];
    const task = execution ? s.tasks[execution.taskId] : undefined;
    if (!execution || !task || call.runId !== s.run.id || task.id !== call.taskId || task.agentId !== call.agentId || task.role !== "VERIFIER" || execution.state !== "RUNNING") throw new Error("Acceptance check must belong to an active verifier task");
    const result = await input.gateway.dispatch(structuredClone(call));
    // No automatic human approval for an acceptance command.
    output.push({ name: check.id, passed: result.status === "EXECUTED" });
  }
  return output;
}
