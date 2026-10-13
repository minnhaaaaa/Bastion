import type { RunSnapshot } from "@bastion/contracts";
import { incidentEvidence } from "../../lib/incident-evidence";

export function IncidentExcerpt({ reason }: { reason: string }) {
  const { excerpt } = incidentEvidence(reason);
  return excerpt ? <blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{excerpt}</blockquote> : <p className="desk-hint">No suspicious excerpt was recorded for this finding.</p>;
}

export function SuspectedText({ snapshot, sourceIds }: { snapshot: RunSnapshot; sourceIds?: string[] }) {
  const incidents = Object.values(snapshot.incidents).filter(i => !sourceIds || sourceIds.includes(i.sourceVersionId));
  if (!incidents.length) return null;
  return <section aria-label="Suspected malicious text"><strong>Suspected malicious text</strong>{incidents.map(i => <div key={i.id}><p className="desk-hint">{snapshot.sources[i.sourceVersionId]?.name ?? i.sourceVersionId} · {i.state} · Sensitive patterns redacted</p><IncidentExcerpt reason={i.reason} /></div>)}</section>;
}
