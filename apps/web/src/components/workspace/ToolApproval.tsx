import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ChevronDown, Check, X } from "lucide-react";
import { type ToolApprovalView } from "@bastion/contracts";
import { api } from "../../lib/api";
import { canResolveAction, reviewedDecision, type ReviewedAction } from "../../lib/tool-review";
import { ErrorBox } from "../ui";

// Operator-only endpoint: raw arguments are fetched only when this card is opened.
export function ToolApproval({ approval, token, reason }: { approval: ToolApprovalView; token: string; reason?: string | null }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const exact = useQuery({ queryKey: ["tool-approval", approval.id, token], queryFn: () => api<ReviewedAction>(`/api/tool-approvals/${approval.id}`, token), enabled: open && approval.status === "PENDING", staleTime: 0, gcTime: 0 });
  const expired = Date.parse(approval.expiresAt) <= now;
  const canResolve = canResolveAction(approval, exact.data, now) && !busy;
  async function resolve(decision: "APPROVE" | "REJECT") {
    if (!canResolve || !exact.data) return;
    setBusy(true); setError(undefined);
    try {
      await api(`/api/tool-approvals/${approval.id}/resolve`, token, reviewedDecision(approval, exact.data, decision, Date.now()));
      await Promise.all([client.invalidateQueries({ queryKey: ["run", approval.runId, token] }), client.invalidateQueries({ queryKey: ["tool-approval", approval.id, token] })]);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <article className="desk-approval">
    <div className="desk-row"><strong><ShieldAlert /> Action needs review</strong><span>{expired && approval.status === "PENDING" ? "EXPIRED" : approval.status}</span></div>
    <h3>{approval.operation}</h3><code>{approval.resourcePreview}</code>
    <p>{reason || approval.reason || "This action requires operator approval."}</p>
    <button type="button" className="desk-subtle" aria-expanded={open} onClick={() => setOpen(!open)}>Review exact action <ChevronDown /></button>
    {open && <div className="desk-exact">
      {exact.isPending && <p>Loading action details…</p>}
      <ErrorBox error={exact.error || error} />
      {exact.data && <><dl><dt>Target</dt><dd>{exact.data.resource}</dd>{exact.data.destination && <><dt>Destination</dt><dd>{exact.data.destination}</dd></>}<dt>Policy</dt><dd>{exact.data.ruleId}</dd><dt>Agent</dt><dd>{exact.data.agentId}</dd><dt>Expires</dt><dd>{new Date(exact.data.expiresAt).toLocaleString()}</dd></dl><pre>{JSON.stringify(exact.data.args, null, 2)}</pre><details><summary>Action fingerprint</summary><code>{exact.data.actionDigest}</code></details>
        <div className="desk-row"><button className="desk-primary" disabled={!canResolve} onClick={() => void resolve("APPROVE")}><Check /> Allow once</button><button className="desk-secondary" disabled={!canResolve} onClick={() => void resolve("REJECT")}><X /> Deny</button></div>
      </>}
    </div>}
  </article>;
}
