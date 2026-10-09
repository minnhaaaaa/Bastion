import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  newId,
  WorkflowDefinition,
  type Workflow,
  type Project,
  type RunSummary,
  type RunSnapshot,
} from "@bastion/contracts";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { usePageIntro } from "../lib/usePageIntro";
import { useRun } from "../lib/useRun";
import { RunGraph } from "../components/RunGraph";
import {
  Arrow,
  Button,
  Connect,
  Empty,
  ErrorBox,
  Header,
} from "../components/ui";
export function Console({ runId }: { runId?: string }) {
  const intro = usePageIntro<HTMLElement>(".console-sidebar > *, .workspace-heading, .metric-row, .workspace-panel, .connect-panel");
  const { token, setToken } = useSession();
  const client = useQueryClient();
  const [selectedRun, setSelectedRun] = useState(runId);
  const [projectId, setProjectId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [tab, setTab] = useState<"graph" | "events" | "incidents">("graph");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selectedNode, setSelectedNode] = useState("");
  const projects = useQuery({
    queryKey: ["projects", token],
    queryFn: () => api<Project[]>("/api/projects", token),
    enabled: !!token,
  });
  const runs = useQuery({
    queryKey: ["runs", token],
    queryFn: () => api<RunSummary[]>("/api/runs", token),
    enabled: !!token,
    refetchInterval: 5000,
  });
  const workflows = useQuery({
    queryKey: ["workflows", projectId, token],
    queryFn: () =>
      api<Workflow[]>(
        `/api/workflows?projectId=${encodeURIComponent(projectId)}`,
        token,
      ),
    enabled: !!projectId && !!token,
  });
  const { snapshot, events, connection } = useRun(selectedRun, token);
  const s = snapshot.data;
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function createProject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void action(async () => {
      const p = await api<Project>("/api/projects", token, {
        commandId: newId("command"),
        name: form.get("name"),
      });
      setProjectId(p.id);
      await client.invalidateQueries({ queryKey: ["projects"] });
    });
  }
  async function upload(file?: File) {
    if (!file || !projectId) return;
    await action(async () => {
      const definition = WorkflowDefinition.parse(
        JSON.parse(await file.text()),
      );
      const wf = await api<Workflow>("/api/workflows", token, {
        commandId: newId("command"),
        projectId,
        definition,
      });
      setWorkflowId(wf.id);
      await client.invalidateQueries({ queryKey: ["workflows"] });
    });
  }
  async function launch() {
    await action(async () => {
      const result = await api<{ runId: string }>("/api/runs", token, {
        commandId: newId("command"),
        workflowId,
        mode: "PROTECTED",
      });
      setSelectedRun(result.runId);
      await client.invalidateQueries({ queryKey: ["runs"] });
    });
  }
  return (
    <>
      <Header active="dashboard" />
      <main ref={intro} id="main" tabIndex={-1} className="console-shell">
        <aside className="console-sidebar">
          <span className="eyebrow">WORKSPACE</span>
          <a href="/dashboard" className="side-link selected">
            ◈ Overview
          </a>
          <a href="/arena" className="side-link">
            ⌁ Arena
          </a>
          <a href="/architecture" className="side-link">
            ◇ Architecture
          </a>
          <div className="sidebar-bottom">
            <span className="mono">SESSION</span>
            <p>{token ? "Operator token supplied" : "Not connected"}</p>
            {token && (
              <button
                className="text-link"
                onClick={() => {
                  setToken("");
                  client.clear();
                }}
              >
                Disconnect <Arrow />
              </button>
            )}
          </div>
        </aside>
        <div className="console-main">
          <div className="workspace-heading">
            <div>
              <span className="eyebrow">BASTION / CONSOLE</span>
              <h1>Workspace.</h1>
            </div>
            <span className="status-badge">
              <span
                className={
                  connection === "Live" ? "status-dot live" : "status-dot"
                }
              />
              {token && selectedRun ? connection : "Awaiting connection"}
            </span>
            {token && (
              <Button
                className="mobile-disconnect"
                onClick={() => {
                  setToken("");
                  client.clear();
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
          {!token ? (
            <Connect />
          ) : (
            <>
              <div className="workspace-controls">
                <label>
                  Project
                  <select
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                      setWorkflowId("");
                    }}
                  >
                    <option value="">Select a project</option>
                    {projects.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Workflow
                  <select
                    value={workflowId}
                    onChange={(e) => setWorkflowId(e.target.value)}
                    disabled={!projectId}
                  >
                    <option value="">Select a workflow</option>
                    {workflows.data?.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.definition.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  onClick={() => void launch()}
                  disabled={!workflowId || busy}
                >
                  Run <Arrow />
                </Button>
                <label
                  className={`button upload-button ${!projectId ? "disabled" : ""}`}
                >
                  Import JSON
                  <input
                    type="file"
                    accept=".json,application/json"
                    disabled={!projectId || busy}
                    onChange={(e) => void upload(e.target.files?.[0])}
                  />
                </label>
              </div>
              <details className="project-create">
                <summary>Create a project</summary>
                <form onSubmit={createProject}>
                  <input
                    aria-label="Project name"
                    name="name"
                    required
                    maxLength={120}
                  />
                  <Button type="submit" disabled={busy}>
                    Create <Arrow />
                  </Button>
                </form>
              </details>
              <ErrorBox
                error={
                  error ||
                  projects.error ||
                  workflows.error ||
                  runs.error ||
                  snapshot.error
                }
              />
              <div className="metric-row">
                <Metric
                  label="TASKS"
                  value={s ? Object.keys(s.tasks).length : null}
                />
                <Metric
                  label="DENIED TOOL CALLS"
                  value={
                    s
                      ? Object.values(s.toolRequests).filter(
                          (t) => t.decision === "DENY",
                        ).length
                      : null
                  }
                />
                <Metric
                  label="INCIDENTS"
                  value={s ? Object.keys(s.incidents).length : null}
                />
                <Metric label="RECORDED EVENTS" value={s?.lastSeq ?? null} />
              </div>
              <section className="workspace-panel">
                <div className="panel-toolbar">
                  <div className="tabs" role="tablist" aria-label="Run views">
                    {(["graph", "events", "incidents"] as const).map((t) => (
                      <button
                        key={t}
                        role="tab"
                        id={`view-${t}`}
                        aria-controls="run-panel"
                        aria-selected={tab === t}
                        onClick={() => setTab(t)}
                      >
                        {t === "graph"
                          ? "Provenance graph"
                          : t === "events"
                            ? "Event journal"
                            : "Incidents"}
                      </button>
                    ))}
                  </div>
                  <label className="run-select">
                    <span className="sr-only">Selected run</span>
                    <select
                      value={selectedRun ?? ""}
                      onChange={(e) => {
                        setSelectedRun(e.target.value || undefined);
                        setSelectedNode("");
                      }}
                    >
                      <option value="">Select a run</option>
                      {runs.data?.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id} · {r.status}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div
                  id="run-panel"
                  role="tabpanel"
                  aria-labelledby={`view-${tab}`}
                  className={
                    tab === "graph" ? "graph-surface" : "journal-surface"
                  }
                >
                  {snapshot.isPending && selectedRun ? (
                    <Empty title="Loading recorded workflow">
                      Fetching the authoritative run snapshot.
                    </Empty>
                  ) : tab === "graph" ? (
                    <RunGraph snapshot={s} onSelect={setSelectedNode} />
                  ) : tab === "events" ? (
                    events.data?.length ? (
                      <div className="event-list">
                        {events.data.map((e) => (
                          <details key={e.eventId}>
                            <summary>
                              <span className="mono">{e.seq}</span>
                              <strong>{e.type}</strong>
                              <time>
                                {new Date(e.timestamp).toLocaleTimeString()}
                              </time>
                            </summary>
                            <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                          </details>
                        ))}
                      </div>
                    ) : (
                      <Empty title="No recorded events">
                        Choose a run to inspect its journal.
                      </Empty>
                    )
                  ) : s ? (
                    <Incidents
                      snapshot={s}
                      token={token}
                      refresh={() =>
                        client.invalidateQueries({
                          queryKey: ["run", selectedRun, token],
                        })
                      }
                    />
                  ) : (
                    <Empty title="No run selected">
                      Choose a workflow run to inspect its incidents.
                    </Empty>
                  )}
                </div>
                {selectedNode && s && (
                  <div className="node-inspector">
                    <div>
                      <span className="eyebrow">SELECTED EVIDENCE</span>
                      <Button onClick={() => setSelectedNode("")}>Close</Button>
                    </div>
                    <pre>
                      {JSON.stringify(
                        s.sources[selectedNode] ??
                          s.artifacts[selectedNode] ??
                          s.toolRequests[selectedNode] ??
                          s.executions[selectedNode] ??
                          s.tasks[selectedNode] ?? { id: selectedNode },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                )}
                <div className="panel-footer mono">
                  <span>
                    {s ? `${s.run.mode} / ${s.run.status}` : "NO RUN SELECTED"}
                  </span>
                  <span>
                    {s
                      ? `GRAPH PROJECTED THROUGH ${s.graphProjectedUpTo}`
                      : "PERSISTED EVIDENCE ONLY"}
                  </span>
                </div>
              </section>
            </>
          )}
          <div className="console-footnote mono">
            BASTION / TRACE · CONTAIN · RECOVER
          </div>
        </div>
      </main>
    </>
  );
}
function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="metric">
      <span className="mono">{label}</span>
      <strong>{value === null ? "—" : value}</strong>
    </div>
  );
}
function Incidents({
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
  const [replacement, setReplacement] = useState("");
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
  const incidents = Object.values(s.incidents);
  if (!incidents.length)
    return (
      <Empty title="No recorded incidents">
        Security incidents will appear here when the run records them.
      </Empty>
    );
  return (
    <div className="incident-list">
      <ErrorBox error={error} />
      {incidents.map((inc) => (
        <article className="incident-card" key={inc.id}>
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
              busy ||
              s.sources[inc.sourceVersionId]?.securityState === "QUARANTINED"
            }
            onClick={() =>
              void post(`/api/incidents/${inc.id}/quarantine`, {
                sourceVersionId: inc.sourceVersionId,
              })
            }
          >
            Quarantine source
          </Button>
          <div className="recovery-controls">
            <label>
              Trusted replacement
              <select
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
              >
                <option value="">Choose a source</option>
                {Object.values(s.sources)
                  .filter(
                    (src) =>
                      src.trust === "TRUSTED" &&
                      src.securityState !== "QUARANTINED",
                  )
                  .map((src) => (
                    <option key={src.id} value={src.id}>
                      {src.name} · v{src.version}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              disabled={busy || !replacement}
              onClick={() =>
                void post(`/api/incidents/${inc.id}/recovery-plan`, {
                  replacementSourceVersionId: replacement,
                })
              }
            >
              Plan recovery
            </Button>
          </div>
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
                  <code>{plan.planDigest}</code>
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
        </article>
      ))}
    </div>
  );
}
