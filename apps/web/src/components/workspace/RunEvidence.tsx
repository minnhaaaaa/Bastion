import { useQuery } from "@tanstack/react-query";
import { Check, CircleHelp, ShieldAlert, GitBranch } from "lucide-react";
import type { RunMetrics, RunSnapshot } from "@bastion/contracts";
import { api } from "../../lib/api";
import { ErrorBox } from "../ui";

export function RunEvidence({ snapshot, token, onTrace }: { snapshot: RunSnapshot; token: string; onTrace(): void }) {
  const metrics = useQuery({ queryKey: ["run-metrics", snapshot.run.id, token, snapshot.lastSeq], queryFn: () => api<RunMetrics>(`/api/runs/${snapshot.run.id}/metrics`, token), refetchInterval: 5000 });
  const checks = snapshot.verification;
  const unavailable = metrics.data?.unsafeActionsExecuted == null;
  return <section className="desk-run-evidence" aria-label="Run verification">
    <div className="desk-section-label"><span>Execution evidence</span><button className="desk-subtle" onClick={onTrace}><GitBranch /> Trace causes</button></div>
    <ErrorBox error={metrics.error} />
    {metrics.isPending ? <p className="desk-hint">Loading measured outcomes…</p> : metrics.data && <dl className="desk-evidence-metrics">
      <div><dt>Unsafe actions executed</dt><dd>{unavailable ? "Not measured" : metrics.data.unsafeActionsExecuted}</dd></div>
      <div><dt>Tool requests denied</dt><dd>{metrics.data.toolCalls.denied}</dd></div>
      <div><dt>Task execution</dt><dd>{metrics.data.tasks.succeeded} / {metrics.data.tasks.total} succeeded</dd></div>
    </dl>}
    <p className="desk-hint">Denials show policy decisions. The sandbox audit measures effects. Task success alone does not verify the result.</p>
    <div className="desk-section-label">Recorded verification</div>
    {!checks?.length ? <p className="desk-hint">No completed verification recorded for this run.</p> : <ul className="desk-verification-list">{checks.map((check, index) => <li key={`${check.name}-${index}`} className={check.passed ? "" : "desk-check-failed"}>{check.passed ? <Check /> : <ShieldAlert />}<div><strong>{check.name.replaceAll("_", " ").replaceAll(".", " · ")}</strong><span>{check.passed ? "Passed" : "Not passed"}</span>{check.detail && <p>{check.detail}</p>}</div></li>)}</ul>}
    {unavailable && <p className="desk-hint"><CircleHelp /> Missing audit evidence cannot establish that no unsafe action occurred.</p>}
  </section>;
}
