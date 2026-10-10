import { DetailDisclosure } from "./DetailDisclosure";
import { Response } from "./RunChat";
import { chatArtifacts } from "../../lib/chat-evidence";
import type { ModelConnection } from "./Connections";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Check, CircleHelp, ShieldAlert, GitBranch, Download } from "lucide-react";
import type { RunMetrics, RunSnapshot, RunSummary, Workflow } from "@bastion/contracts";
import { api } from "../../lib/api";
import { ErrorBox } from "../ui";
import { DataSelect } from "../ui/data-select";

type Comparison = { protected: RunMetrics; baseline: RunMetrics; sameWorkflowVersion: boolean; sameAttackContent: boolean };

export function RunEvidence({ snapshot, token, onTrace }: { snapshot: RunSnapshot; token: string; onTrace(): void }) {
  const [otherRun, setOtherRun] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>();
  const metrics = useQuery({ queryKey: ["run-metrics", snapshot.run.id, token, snapshot.lastSeq], queryFn: () => api<RunMetrics>(`/api/runs/${snapshot.run.id}/metrics`, token), refetchInterval: 5000 });
  const workflow = useQuery({ queryKey: ["run-policy", snapshot.run.workflowId, snapshot.run.workflowVersion, token], queryFn: () => api<Workflow>(`/api/workflows/${snapshot.run.workflowId}?version=${snapshot.run.workflowVersion}`, token) });
  const models = useQuery({ queryKey: ["run-models", snapshot.run.workflowId, snapshot.run.workflowVersion, token], queryFn: () => api<{ bindings: Record<string, string>; connections: ModelConnection[] }>(`/api/workflows/${snapshot.run.workflowId}/models?version=${snapshot.run.workflowVersion}`, token) });
  const runs = useQuery({ queryKey: ["comparison-runs", snapshot.run.projectId, token], queryFn: () => api<RunSummary[]>(`/api/runs?projectId=${encodeURIComponent(snapshot.run.projectId)}`, token), refetchInterval: 5000 });
  const candidates = runs.data?.filter(run => run.workflowId === snapshot.run.workflowId && run.mode !== snapshot.run.mode) ?? [];
  const selectedOther = candidates.some(run => run.id === otherRun) ? otherRun : "";
  const comparison = useQuery({ queryKey: ["run-comparison", snapshot.run.id, selectedOther, token, snapshot.lastSeq], queryFn: () => api<Comparison>(`/api/compare?protected=${encodeURIComponent(snapshot.run.mode === "PROTECTED" ? snapshot.run.id : selectedOther)}&baseline=${encodeURIComponent(snapshot.run.mode === "BASELINE" ? snapshot.run.id : selectedOther)}`, token), enabled: !!selectedOther, refetchInterval: 5000 });
  async function exportTrace() {
    setExporting(true); setExportError(undefined);
    try {
      const trace = await api<unknown>(`/api/runs/${snapshot.run.id}/export`, token);
      const url = URL.createObjectURL(new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `${snapshot.run.id}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setExportError(error); } finally { setExporting(false); }
  }
  const checks = snapshot.verification;
  const unavailable = metrics.data?.unsafeActionsExecuted == null;
  return <section className="desk-run-evidence" aria-label="Run verification">
    <DetailDisclosure title="Agent assessment">
    {chatArtifacts(snapshot).map(artifact => <DetailDisclosure key={artifact.id} title={artifact.name}>
      <Response snapshot={snapshot} artifact={artifact} token={token} animate={false} />
    </DetailDisclosure>)}
    {!chatArtifacts(snapshot).length && <p className="desk-hint">No final agent response recorded yet.</p>}
    </DetailDisclosure>
    <DetailDisclosure title="Execution evidence"><div className="desk-section-label"><button className="desk-subtle" onClick={onTrace}><GitBranch /> Trace causes</button></div>
    <ErrorBox error={metrics.error} />
    <button className="desk-secondary" disabled={exporting} onClick={() => void exportTrace()}><Download />{exporting ? "Exporting…" : "Export recorded trace"}</button>
    <ErrorBox error={exportError} />
    {metrics.isPending ? <p className="desk-hint">Loading measured outcomes…</p> : metrics.data && <dl className="desk-evidence-metrics">
      <div><dt>Unsafe actions executed</dt><dd>{unavailable ? "Not measured" : metrics.data.unsafeActionsExecuted}</dd></div>
      <div><dt>Tool requests denied</dt><dd>{metrics.data.toolCalls.denied}</dd></div>
      <div><dt>Task execution</dt><dd>{metrics.data.tasks.succeeded} / {metrics.data.tasks.total} succeeded</dd></div>
    </dl>}
    <p className="desk-hint">Denials show policy decisions. The sandbox audit measures effects. Task success alone does not verify the result.</p>
    </DetailDisclosure>
    <DetailDisclosure title="Recorded verification">
    {!checks?.length ? <p className="desk-hint">No completed verification recorded for this run.</p> : <ul className="desk-verification-list">{checks.map((check, index) => <li key={`${check.name}-${index}`} className={check.passed ? "" : "desk-check-failed"}>{check.passed ? <Check /> : <ShieldAlert />}<div><strong>{check.name.replaceAll("_", " ").replaceAll(".", " · ")}</strong><span>{check.passed ? "Passed" : "Not passed"}</span>{check.detail && <p>{check.detail}</p>}</div></li>)}</ul>}
    {unavailable && <p className="desk-hint"><CircleHelp /> Missing audit evidence cannot establish that no unsafe action occurred.</p>}
    </DetailDisclosure>
    <DetailDisclosure title="Agent models for this run"><ErrorBox error={models.error} />{models.data && (Object.keys(models.data.bindings).length ? Object.entries(models.data.bindings).map(([agent, connectionId]) => { const connection = models.data.connections.find(item => item.id === connectionId); return <p key={agent}><code>{agent}</code><br />{connection ? `${connection.provider} · ${connection.model}` : "Connection unavailable"}</p>; }) : <p>No per-agent model assignment was recorded for this older workflow. Current controller settings cannot establish its historical model.</p>)}</DetailDisclosure>
    <DetailDisclosure title="Policies for this run">
      <ErrorBox error={workflow.error} />
      {workflow.isPending ? <p role="status">Loading policies…</p> : workflow.data && <>
        <p className="desk-hint">Workflow version {workflow.data.version}. These rules are fixed for this run; ungranted actions are denied.</p>
        {!workflow.data.definition.policyRules.length && <p>No tool permissions granted.</p>}
        {workflow.data.definition.policyRules.map(rule => <article className="desk-result" key={rule.id}><strong>{rule.decision} · {rule.operation}</strong><p>{rule.description}</p><code>{rule.resourcePattern}</code></article>)}
      </>}
    </DetailDisclosure>
    <DetailDisclosure title="Compare recorded runs">
      <p className="desk-hint">Compare the same workflow with and without policy enforcement. This does not start a new run.</p>
      <ErrorBox error={runs.error || comparison.error} />
      <DataSelect aria-label="Comparison run" value={selectedOther} onValueChange={setOtherRun} disabled={runs.isPending || !candidates.length}>
        <option value="">{candidates.length ? "Choose a comparison run" : "No opposite-mode run recorded"}</option>
        {candidates.map(run => <option key={run.id} value={run.id}>{run.mode} · {run.status} · {run.id}</option>)}
      </DataSelect>
      {selectedOther && comparison.isPending && <p role="status">Loading comparison…</p>}
      {comparison.data && <>
        <p className="desk-hint">{comparison.data.sameWorkflowVersion ? "Same workflow version." : "Different workflow versions; not a controlled pair."} {comparison.data.sameAttackContent ? "Recorded attack hashes match." : "Matching attack content has not been established."}</p>
        <div className="desk-comparison-scroll"><table className="desk-comparison"><thead><tr><th scope="col">Measured outcome</th><th scope="col">Protected</th><th scope="col">Baseline</th></tr></thead><tbody>
          <tr><th scope="row">Status</th><td>{comparison.data.protected.status}</td><td>{comparison.data.baseline.status}</td></tr>
          <tr><th scope="row">Unsafe actions</th><td>{comparison.data.protected.unsafeActionsExecuted ?? "Not measured"}</td><td>{comparison.data.baseline.unsafeActionsExecuted ?? "Not measured"}</td></tr>
          <tr><th scope="row">Denied requests</th><td>{comparison.data.protected.toolCalls.denied}</td><td>{comparison.data.baseline.toolCalls.denied}</td></tr>
          <tr><th scope="row">Verified completion</th><td>{comparison.data.protected.legitimateCompletion ? "Yes" : "No"}</td><td>{comparison.data.baseline.legitimateCompletion ? "Yes" : "No"}</td></tr>
        </tbody></table></div>
      </>}
    </DetailDisclosure>
  </section>;
}
