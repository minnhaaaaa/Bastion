import { DetailDisclosure } from "./DetailDisclosure";
import { useState } from "react";
import { newId, type RunSnapshot } from "@bastion/contracts";
import { api } from "../../lib/api";
import { DataSelect } from "../ui/data-select";
import { Button, Empty, ErrorBox } from "../ui";
export function Incidents({
  snapshot: s,
  token,
  refresh,
}: {
  snapshot: RunSnapshot;
  token: string;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  async function post(path: string, body: object) {
    setBusy(true);
    setError(null);
    try {
      await api(path, token, { commandId: newId("command"), ...body });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function quarantine(incidentId: string, sourceVersionId: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ suggestedReplacementSourceVersionId: string | null }>(`/api/incidents/${incidentId}/quarantine`, token, { commandId: newId("command"), sourceVersionId });
      if (result.suggestedReplacementSourceVersionId) {
        const replacementSourceVersionId = result.suggestedReplacementSourceVersionId;
        setReplacements(current => ({ ...current, [incidentId]: replacementSourceVersionId }));
        await api(`/api/incidents/${incidentId}/recovery-plan`, token, { commandId: newId("command"), replacementSourceVersionId });
      }
    } catch (e) {
      setError(e);
    } finally {
      // Containment may have succeeded even when planning failed.
      try { await refresh(); } catch (e) { setError(e); }
      setBusy(false);
    }
  }
  const incidents = Object.values(s.incidents);
  if (!incidents.length)
    return (
      <Empty title="No backend incidents recorded">
        The controller has not recorded an incident for this run. An agent may still have reported an injection attempt in its response; review Agent assessment above. This is not evidence that the inputs were attack-free.
      </Empty>
    );
  return (
    <div className="incident-list">
      <ErrorBox error={error} />
      {incidents.map((inc) => (
        <DetailDisclosure key={inc.id} title={`Incident · ${s.sources[inc.sourceVersionId]?.name ?? inc.id}`}>
          <div className="incident-title">
            <span className="status-badge">
              {inc.severity} / {inc.state}
            </span>
            <span className="mono">{inc.id}</span>
          </div>
          <h3>{inc.reason}</h3>
          <p>
            Source:{" "}
            {s.sources[inc.sourceVersionId]?.name ?? inc.sourceVersionId}
          </p>
          <Button
            disabled={
              busy || inc.state !== "OPEN"
            }
            onClick={() =>
              void quarantine(inc.id, inc.sourceVersionId)
            }
          >
            Contain & prepare recovery
          </Button>
          {["QUARANTINED", "RECOVERY_PLANNED", "RECOVERY_FAILED"].includes(inc.state) && <details className="recovery-options" open={inc.state !== "RECOVERY_PLANNED"}>
          <summary>{inc.state === "RECOVERY_PLANNED" ? "Change replacement source" : "Choose a trusted replacement"}</summary>
          <div className="recovery-controls">
            <label>
              Trusted replacement
              <DataSelect
                aria-label="Trusted replacement"
                value={replacements[inc.id] ?? ""}
                onValueChange={(value) => setReplacements(current => ({ ...current, [inc.id]: value }))}
              >
                <option value="">Choose a source</option>
                {Object.values(s.sources)
                  .filter(
                    (src) =>
                      src.trust === "TRUSTED" &&
                      src.securityState === "CLEAR",
                  )
                  .map((src) => (
                    <option key={src.id} value={src.id}>
                      {src.name} · v{src.version}
                    </option>
                  ))}
              </DataSelect>
            </label>
            <Button
              disabled={busy || !replacements[inc.id]}
              onClick={() =>
                void post(`/api/incidents/${inc.id}/recovery-plan`, {
                  replacementSourceVersionId: replacements[inc.id],
                })
              }
            >
              Plan recovery
            </Button>
          </div>
          </details>}
          {Object.values(s.approvals)
            .filter((a) => a.incidentId === inc.id && a.status === "PENDING")
            .map((a) => {
              const plan = s.plans[a.planId];
              return plan ? (
                <div className="approval" key={a.id}>
                  <h4>Review recovery plan</h4>
                  <p>
                    Rerun:{" "}
                    {plan.rerunTaskIds
                      .map((id) => s.tasks[id]?.title ?? id)
                      .join(", ") || "None"}
                  </p>
                  <p>
                    Preserve:{" "}
                    {plan.preservedTaskIds
                      .map((id) => s.tasks[id]?.title ?? id)
                      .join(", ") || "None"}
                  </p>
                  <p>
                    Replacement:{" "}
                    {s.sources[plan.replacementSourceVersionId]?.name ??
                      plan.replacementSourceVersionId}
                  </p>
                  <details><summary>Plan identifier</summary><code>{plan.planDigest}</code></details>
                  <div className="hero-actions">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void post(`/api/incidents/${inc.id}/approve-recovery`, {
                          approvalId: a.id,
                          planId: plan.id,
                          actionDigest: a.actionDigest,
                          decision: "APPROVE",
                        })
                      }
                    >
                      Approve exact plan
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void post(`/api/incidents/${inc.id}/approve-recovery`, {
                          approvalId: a.id,
                          planId: plan.id,
                          actionDigest: a.actionDigest,
                          decision: "REJECT",
                        })
                      }
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ) : null;
            })}
        </DetailDisclosure>
      ))}
    </div>
  );
}
