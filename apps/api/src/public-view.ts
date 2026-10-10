import type { RunEvent, RunSnapshot } from "@bastion/contracts";

function sensitiveExecution(snapshot: RunSnapshot, executionId: string | undefined) {
  return snapshot.edges.some(edge => edge.relation === "CONSUMED" && edge.toId === executionId &&
    (snapshot.sources[edge.fromId] ?? snapshot.artifacts[edge.fromId])?.classification !== "PUBLIC");
}

/** Apply at read/fan-out boundaries too: old persisted previews may predate broker hardening. */
export function publicEvent(event: RunEvent, snapshot: RunSnapshot): RunEvent {
  const result = structuredClone(event);
  if ((result.type === "source.ingested" || result.type === "source.modified" || result.type === "artifact.published") && result.payload.classification !== "PUBLIC") result.payload.preview = "";
  if (result.type === "claim.unverified" && snapshot.artifacts[result.payload.artifactVersionId]?.classification !== "PUBLIC") result.payload.claim = "";
  if (result.type === "incident.opened" && snapshot.sources[result.payload.sourceVersionId]?.classification !== "PUBLIC") result.payload.reason = "Incident details withheld for a non-public source; operator review required";
  if (result.type === "tool.approval_requested" && sensitiveExecution(snapshot, snapshot.toolRequests[result.payload.toolRequestId]?.executionId)) result.payload.resourcePreview = "";
  return result;
}

export function publicSnapshot(snapshot: RunSnapshot): RunSnapshot {
  const result = structuredClone(snapshot);
  for (const value of [...Object.values(result.sources), ...Object.values(result.artifacts)]) if (value.classification !== "PUBLIC") value.preview = "";
  for (const incident of Object.values(result.incidents)) if (result.sources[incident.sourceVersionId]?.classification !== "PUBLIC") incident.reason = "Incident details withheld for a non-public source; operator review required";
  for (const approval of Object.values(result.toolApprovals)) if (sensitiveExecution(result, result.toolRequests[approval.toolRequestId]?.executionId)) approval.resourcePreview = "";
  return result;
}
