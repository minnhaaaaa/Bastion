import { DetailDisclosure } from "../components/workspace/DetailDisclosure";
import { Response, RunChat } from "../components/workspace/RunChat";
import { readTaskDocuments, type TaskDocument } from "../lib/task-documents";
import { WorkflowModels } from "../components/workspace/WorkflowModels";
import { Connections, ProjectModel, useConnections, useProjectModel } from "../components/workspace/Connections";
import { SecurityGuide } from "../components/workspace/SecurityGuide";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Bot, ChevronRight, FileText, Folder, LogOut, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, ShieldCheck, ShieldAlert, ArrowUp, X, Activity, Upload, Paperclip, LockKeyhole } from "lucide-react";
import { newId, WorkflowDefinition, type Workflow, type Project, type RunSummary } from "@bastion/contracts";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { useRun } from "../lib/useRun";
import { withTaskInstruction } from "../lib/workflow-draft";
import { RunGraph } from "../components/RunGraph";
import { Connect, ErrorBox } from "../components/ui";
import { DataSelect } from "../components/ui/data-select";
import { WorkflowSetup } from "../components/workspace/WorkflowSetup";
import { ToolApproval } from "../components/workspace/ToolApproval";
import { Incidents } from "../components/workspace/Incidents";
import { ProjectRepository, type RepositoryView } from "../components/workspace/ProjectRepository";
import { RunEvidence } from "../components/workspace/RunEvidence";
import "../desktop-workspace.css";

export function Console({ runId }: { runId?: string }) {
  const { token, setToken } = useSession();
  const client = useQueryClient();
  const [selectedRun, setSelectedRun] = useState(runId);
  const [projectId, setProjectId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [followUp, setFollowUp] = useState(false);
  const [manualRun, setManualRun] = useState(false);
  const submissionEpoch = useRef(0);
  const [launchStage, setLaunchStage] = useState("");
  const [documents, setDocuments] = useState<TaskDocument[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [instruction, setInstruction] = useState("");
  const [search, setSearch] = useState("");
  const [sidebar, setSidebar] = useState(() => !window.matchMedia("(max-width: 760px)").matches);
  const [settings, setSettings] = useState(false);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (settings) settingsDialog.current?.showModal(); }, [settings]);
  const [guide, setGuide] = useState(false);
  const modelConnections = useConnections(token);
  const projectModel = useProjectModel(token, projectId);
  const [setup, setSetup] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "projects" | "runs"; id: string; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>();
  const deleteDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!deleteTarget) return;
    const origin = document.activeElement as HTMLElement | null;
    const dialog = deleteDialog.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (origin?.isConnected) origin.focus(); };
  }, [deleteTarget]);
  function requestDelete(kind: "projects" | "runs", id: string, name: string) { setDeleteError(undefined); setDeleteTarget({ kind, id, name }); }
  async function deleteSelected() {
    if (!deleteTarget || busy) return;
    const target = deleteTarget;
    setBusy(true); setDeleteError(undefined);
    try {
      await api(`/api/${target.kind}/${target.id}/delete`, token, { commandId: newId("command") });
      if (target.kind === "projects" && target.id === projectId) chooseProject("");
      if (target.kind === "runs" && target.id === selectedRun) { setSelectedRun(undefined); setFollowUp(false); setInspection(null); }
      client.removeQueries({ queryKey: ["run", target.id] });
      client.removeQueries({ queryKey: ["artifact-content"] });
      setDeleteTarget(null);
      await Promise.all([client.invalidateQueries({ queryKey: ["projects"] }), client.invalidateQueries({ queryKey: ["runs"] })]);
    } catch (failure) { setDeleteError(failure); }
    finally { setBusy(false); }
  }

  const [inspection, setInspection] = useState<"results" | "security" | "graph" | "activity" | null>(null);
  const inspectionDialog = useRef<HTMLDialogElement>(null);
  const [submittedPrompts, setSubmittedPrompts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!inspection) return;
    const origin = document.activeElement as HTMLElement | null;
    const dialog = inspectionDialog.current;
    if (!dialog?.open) dialog?.showModal();
    return () => { dialog?.close(); if (origin?.isConnected) origin.focus(); };
  }, [inspection !== null]);
  const [selectedNode, setSelectedNode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [olderEventsBusy, setOlderEventsBusy] = useState(false);
  const projects = useQuery({ queryKey: ["projects", token], queryFn: () => api<Project[]>("/api/projects", token), enabled: !!token });
  const runs = useQuery({ queryKey: ["runs", projectId, token], queryFn: () => api<RunSummary[]>(`/api/runs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, token), enabled: !!token, refetchInterval: 5000 });
  const workflows = useQuery({ queryKey: ["workflows", projectId, token], queryFn: () => api<Workflow[]>(`/api/workflows?projectId=${encodeURIComponent(projectId)}`, token), enabled: !!projectId && !!token });
  const repository = useQuery({ queryKey: ["repository", projectId, token], queryFn: () => api<{ repository: RepositoryView | null }>(`/api/projects/${projectId}/repository`, token), enabled: !!projectId && !!token });
  const provider = useQuery({ queryKey: ["provider-connection", token], queryFn: () => api<{ runtime: { provider: string; model: string } | null; repositoryAvailable: boolean; attachments?: { maxBytes: number } | null }>("/api/connection", token), enabled: !!token });
  const health = useQuery({ queryKey: ["controller-health", token], queryFn: () => api<{ runtimeConnected: boolean; taskPlanningConnected: boolean }>("/health", token), enabled: !!token, refetchInterval: 10000 });
  const { snapshot, events, connection } = useRun(selectedRun, token);
  const s = snapshot.data;
  const selectedWorkflow = workflows.data?.find(w => w.id === workflowId);
  const selectedTask = selectedWorkflow?.definition.tasks.find(t => t.id === taskId);
  const currentProject = projects.data?.find(p => p.id === projectId);
  const pending = s ? Object.values(s.toolApprovals).filter(a => a.status === "PENDING") : [];
  const activeAgents = s ? new Set(Object.values(s.executions).filter(e => e.state === "RUNNING").map(e => s.tasks[e.taskId]?.agentId).filter(Boolean)).size : null;
  useEffect(() => { if (s && !projectId) setProjectId(s.run.projectId); }, [s, projectId]);
  function chooseProject(id: string) { submissionEpoch.current++; setDocuments([]); setReadingFiles(false); setInspection(null); setManualRun(false); setFollowUp(false); setProjectId(id); setWorkflowId(""); setTaskId(""); setSelectedRun(undefined); setInstruction(""); setSelectedNode(""); setSetup(false); setError(undefined); }
  function chooseWorkflow(id: string) { setWorkflowId(id); const workflow = workflows.data?.find(w => w.id === id); setTaskId(workflow?.definition.tasks.length === 1 ? workflow.definition.tasks[0]!.id : ""); }
  function disconnect() { setToken(""); client.clear(); chooseProject(""); setSettings(false); }
  async function action(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(undefined); try { await fn(); } catch (failure) { setError(failure); } finally { setBusy(false); } }
  async function saved(workflow: Workflow) { setManualRun(true); await client.invalidateQueries({ queryKey: ["workflows"] }); setWorkflowId(workflow.id); setTaskId(workflow.definition.tasks[0]?.id ?? ""); setInstruction(""); setSetup(false); setSettings(false); }
  function createProject(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); void action(async () => { const p = await api<Project>("/api/projects", token, { commandId: newId("command"), name: String(data.get("name")).trim() }); await client.invalidateQueries({ queryKey: ["projects"] }); chooseProject(p.id); setCreatingProject(false); }); }
  async function upload(file?: File) { if (!file || !projectId) return; await action(async () => { const definition = WorkflowDefinition.parse(JSON.parse(await file.text())); const workflow = await api<Workflow>("/api/workflows", token, { commandId: newId("command"), projectId, definition }); await saved(workflow); }); }
  async function addFiles(files: File[]) {
    if (!files.length || readingFiles || !provider.data?.attachments) return;
    const epoch = submissionEpoch.current;
    setReadingFiles(true); setError(undefined);
    try {
      const added = await readTaskDocuments(files, documents, provider.data.attachments.maxBytes);
      if (epoch === submissionEpoch.current) setDocuments(added);
    } catch (failure) { if (epoch === submissionEpoch.current) setError(failure); }
    finally { if (epoch === submissionEpoch.current) setReadingFiles(false); }
  }
  async function launch() {
    if (readingFiles || !projectId || (manualRun ? !selectedWorkflow || !selectedTask : !instruction.trim())) return;
    const epoch = submissionEpoch.current;
    await action(async () => {
      try {
        let workflow: Workflow;
        if (manualRun && selectedWorkflow && selectedTask) {
          workflow = selectedWorkflow;
          if (instruction.trim()) {
            workflow = await api<Workflow>(`/api/workflows/${selectedWorkflow.id}/versions`, token, { commandId: newId("command"), definition: withTaskInstruction(selectedWorkflow, taskId, instruction) });
          }
        } else {
          setLaunchStage("Preparing your task…");
          const plan = await api<{ definition: unknown }>(`/api/projects/${projectId}/task-plan`, token, { commandId: newId("command"), instruction: instruction.trim(), ...(documents.length ? { documents } : {}), ...(projectModel.data?.connectionId ? { connectionId: projectModel.data.connectionId } : {}), ...(followUp && selectedRun ? { contextRunId: selectedRun } : {}), ...(!followUp && selectedWorkflow ? { baseWorkflowId: selectedWorkflow.id, baseWorkflowVersion: selectedWorkflow.version } : {}) });
          if (epoch !== submissionEpoch.current) return;
          setLaunchStage("Saving the plan…");
          const modelSource = followUp && s ? { id: s.run.workflowId, version: s.run.workflowVersion } : selectedWorkflow;
          const assignments = modelSource ? await api<{ bindings: Record<string, string> }>(`/api/workflows/${modelSource.id}/models?version=${modelSource.version}`, token) : { bindings: {} };
          if (epoch !== submissionEpoch.current) return;
          workflow = await api<Workflow>("/api/workflows", token, { commandId: newId("command"), projectId, ...(projectModel.data?.connectionId ? { connectionId: projectModel.data.connectionId } : {}), agentConnections: assignments.bindings, definition: WorkflowDefinition.parse(plan.definition) });
        }
        if (epoch !== submissionEpoch.current) return;
        await client.invalidateQueries({ queryKey: ["workflows"] });
        if (epoch !== submissionEpoch.current) return;
        setLaunchStage("Starting protected work…");
        const result = await api<{ runId: string }>("/api/runs", token, { commandId: newId("command"), workflowId: workflow.id, mode: "PROTECTED" });
        if (epoch !== submissionEpoch.current) return;
        setSubmittedPrompts(current => ({ ...current, [result.runId]: instruction.trim() })); setFollowUp(false); setSelectedRun(result.runId); setSelectedNode(""); setInstruction(""); setDocuments([]); await client.invalidateQueries({ queryKey: ["runs"] });
      } finally { setLaunchStage(""); }
    });
  }
  const matches = (text: string) => text.toLowerCase().includes(search.trim().toLowerCase());
  const currentError = error || repository.error || provider.error || projects.error || runs.error || workflows.error || snapshot.error || events.error;
  return <main id="main" tabIndex={-1} className={`desk ${sidebar ? "" : "desk-sidebar-hidden"}`}>
    <header className="desk-titlebar">
      <div className="desk-breadcrumb"><Folder /><span>{currentProject?.name || "No project selected"}</span><ChevronRight /><span>{selectedRun ? "Run activity" : "New task"}</span></div>
      <button className="desk-subtle" disabled={!token} onClick={() => setSettings(true)}>Connections</button><button className="desk-subtle" aria-expanded={guide} onClick={() => setGuide(!guide)}>Security walkthrough</button><button className={`desk-icon ${settings ? "is-selected" : ""}`} aria-label="Settings" aria-pressed={settings} onClick={() => setSettings(!settings)}><Settings2 /></button>
    </header>
    <aside className="desk-sidebar">
      <div className="desk-sidebar-dismiss"><span>Workspace</span><button className="desk-icon" aria-label="Close sidebar" onClick={() => setSidebar(false)}><X /></button></div>
      <button className="desk-new" disabled={busy} onClick={() => { submissionEpoch.current++; setDocuments([]); setReadingFiles(false); setManualRun(false); setWorkflowId(""); setTaskId(""); setFollowUp(false); setSelectedRun(undefined); setSelectedNode(""); setSetup(false); }}><Plus /> New task</button>
      <label className="desk-search"><Search /><input aria-label="Search projects and runs" placeholder="Search workspace" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="desk-section-label"><span>Projects</span><button className="desk-icon" aria-label="Create project" disabled={!token} onClick={() => setCreatingProject(!creatingProject)}><Plus /></button></div>
      {creatingProject && <form className="desk-project-form" onSubmit={createProject}><input name="name" aria-label="Project name" placeholder="Project name" required maxLength={120} autoFocus /><button className="desk-secondary" disabled={busy}>Create project</button></form>}
      <div className="desk-projects">{projects.isFetching && <p className="desk-muted">Loading projects…</p>}{projects.data?.filter(p => matches(p.name)).map(p => <div className="desk-nav-row" key={p.id}><button className={`desk-nav ${p.id === projectId ? "is-selected" : ""}`} onClick={() => chooseProject(p.id)}><Folder /><span>{p.name}</span>{p.id === projectId && <ChevronRight />}</button><button className="desk-icon desk-delete" aria-label={`Delete project ${p.name}`} title="Delete project" disabled={busy} onClick={() => requestDelete("projects", p.id, p.name)}><Trash2 /></button></div>)}{projects.isSuccess && !projects.data.length && <p className="desk-muted">Create a project to organize your work.</p>}</div>
      <div className="desk-section-label"><span>Recent runs</span><Activity /></div>
      <div className="desk-run-list">{runs.data?.filter(r => matches(`${r.id} ${r.status} ${workflows.data?.find(w => w.id === r.workflowId)?.definition.name || ""}`)).map(r => <div className="desk-nav-row" key={r.id}><button className={`desk-nav desk-run ${selectedRun === r.id ? "is-selected" : ""}`} onClick={() => { setFollowUp(false); setSelectedRun(r.id); setSelectedNode(""); setSetup(false); }}><MessageSquare /><span><strong>{workflows.data?.find(w => w.id === r.workflowId)?.definition.name || r.id}</strong><small>{r.status.toLowerCase().replaceAll("_", " ")}{r.startedAt ? ` · ${new Date(r.startedAt).toLocaleDateString()}` : ""}</small></span></button><button className="desk-icon desk-delete" aria-label={`Delete run ${r.id}`} title={["COMPLETED", "RECOVERED", "FAILED", "RECOVERY_FAILED"].includes(r.status) ? "Delete run" : "Wait for this run to finish"} disabled={busy || !["COMPLETED", "RECOVERED", "FAILED", "RECOVERY_FAILED"].includes(r.status)} onClick={() => requestDelete("runs", r.id, workflows.data?.find(w => w.id === r.workflowId)?.definition.name || r.id)}><Trash2 /></button></div>)}{runs.isSuccess && !runs.data.length && <p className="desk-muted">Your runs will appear here.</p>}</div>
      <div className="desk-sidebar-bottom"><button className="desk-nav" disabled={!token || !projectId} onClick={() => { setSetup(true); setSettings(false); }}><Bot /><span>Advanced workflows</span></button><button className="desk-nav" onClick={() => setSettings(!settings)}><Settings2 /><span>Settings</span></button>{token && <button className="desk-nav" onClick={disconnect}><LogOut /><span>Disconnect</span></button>}<a className="desk-site-link" href="/">About Bastion <ChevronRight /></a></div>
    </aside>
    <section className="desk-conversation" aria-label="Task workspace">
      <div className="desk-pane-heading"><button className="desk-icon" aria-label={sidebar ? "Hide sidebar" : "Show sidebar"} onClick={() => setSidebar(!sidebar)}>{sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}</button><h1>{setup ? "Workflow setup" : selectedRun ? "Conversation" : "New task"}</h1><nav className="desk-review-launchers" aria-label="Run details">{(["results", "security", "graph", "activity"] as const).map(view => <button key={view} type="button" className="desk-subtle" aria-haspopup="dialog" aria-label={view === "graph" ? "Trace" : view === "security" ? "Security" : view === "activity" ? "Activity" : "Results"} disabled={!s} onClick={() => setInspection(view)}><span>{view === "graph" ? "Trace" : view === "security" ? "Security" : view === "activity" ? "Activity" : "Results"}</span></button>)}</nav><span className="desk-connection"><i className={selectedRun && connection === "Live" ? "connected" : ""} />{token ? selectedRun ? connection : "Operator connected" : "Not connected"}</span></div>
      <div className="desk-scroll">
        <ErrorBox error={currentError} />
        {guide && <SecurityGuide snapshot={s} onInspect={setInspection} onConnections={() => setSettings(true)} />}
        {!token ? <div className="desk-welcome"><div className="desk-emblem"><LockKeyhole /></div><h2>Your agents. Your boundaries.</h2><p>Connect to your controller to start a task and review the actions your agents take.</p><Connect /></div> : setup && projectId ? <WorkflowSetup key={projectId} projectId={projectId} token={token} onSaved={workflow => void saved(workflow)} /> : !selectedRun ? <div className="desk-welcome"><div className="desk-emblem"><MessageSquare /></div><h2>What are we working on?</h2><p>Give your agents a task. Follow their work here, with sensitive actions held for your review.</p><div className="desk-onboarding"><div><Bot /><span><strong>Connect your model</strong><small>{modelConnections.data?.connections.some(item => !item.disabled) ? "Choose a connection for this project." : "Add your provider account or API key once."}</small></span><button className="desk-subtle" onClick={() => setSettings(true)}>Connect <ChevronRight /></button></div><div><Folder /><span><strong>{currentProject?.name || "Choose a project"}</strong><small>{projectId ? "Project selected" : "Select a project in the sidebar or create one."}</small></span>{!projectId && <button className="desk-subtle" onClick={() => setCreatingProject(true)}>Create <Plus /></button>}</div><div><Bot /><span><strong>Describe the task</strong><small>Bastion prepares the agents and steps from your instructions.</small></span></div><div><ShieldCheck /><span><strong>Review as they work</strong><small>Approval requests and results appear with the activity.</small></span></div></div></div> : <div className="desk-activity">
          {snapshot.isPending && <p className="desk-muted">Loading conversation…</p>}
          {s && <RunChat key={s.run.id} snapshot={s} events={events.data ?? []} token={token} prompt={submittedPrompts[s.run.id]} onInspect={setInspection} />}
          {pending.map(a => <ToolApproval key={a.id} approval={a} token={token} reason={s?.toolRequests[a.toolRequestId]?.reason} />)}
        </div>}
      </div>
      {token && !setup && <form className="desk-composer" onSubmit={e => { e.preventDefault(); void launch(); }}>
        {activeAgents !== null && activeAgents > 0 && <div className="desk-composer-top"><span className="desk-agent-count">{activeAgents} running</span></div>}
        <label className="sr-only" htmlFor="task-instruction">Task instructions</label><textarea id="task-instruction" placeholder={projectId ? "What would you like to work on?" : "Choose a project to get started…"} value={instruction} onChange={e => setInstruction(e.target.value)} disabled={!projectId || busy} rows={1} />
        {documents.length > 0 && <ul className="desk-attachments" aria-label="Attached documents">{documents.map(document => <li key={document.name}><FileText aria-hidden="true" /><span title={document.name}>{document.name}</span><button type="button" className="desk-icon" disabled={busy || readingFiles} aria-label={`Remove ${document.name}`} onClick={() => setDocuments(current => current.filter(item => item.name !== document.name))}><X /></button></li>)}</ul>}
        <input ref={fileInput} type="file" multiple hidden accept=".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.log,text/*" aria-label="Attach text documents" onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <div className="desk-composer-controls"><button type="button" className="desk-attach" disabled={!projectId || busy || readingFiles || manualRun || !!selectedWorkflow || followUp || !provider.data?.attachments} onClick={() => fileInput.current?.click()} title={manualRun || selectedWorkflow || followUp ? "Attach files to a new task without a saved workflow or follow-up context" : "Attach text documents (TXT, Markdown, CSV, JSON)"}><Paperclip aria-hidden="true" />{readingFiles ? "Reading…" : "Add files"}</button><span className="desk-hint">{selectedWorkflow ? `Using ${selectedWorkflow.definition.name}` : repository.data?.repository ? `Connected: ${repository.data.repository.directory}` : documents.length ? `${documents.length} document${documents.length === 1 ? "" : "s"} attached` : "No file or network access granted"}</span><button className="desk-send" aria-label="Start protected task" title="Start protected task" disabled={!projectId || busy || readingFiles || (!manualRun && modelConnections.data?.enabled === true && !modelConnections.data.connections.some(item => item.id === projectModel.data?.connectionId && !item.disabled)) || health.data?.runtimeConnected !== true || (manualRun ? !selectedTask : !instruction.trim() || health.data?.taskPlanningConnected !== true)}><ArrowUp /></button></div>
        {documents.length > 0 && <p className="desk-hint">Files are sent with this task and treated as untrusted documents.</p>}
        {readingFiles && <p className="desk-hint" role="status">Reading attached documents…</p>}
        {launchStage && <p role="status" className="desk-hint">{launchStage}</p>}
        {s && ["COMPLETED", "RECOVERED"].includes(s.run.status) && <label className="desk-check"><input type="checkbox" checked={followUp} disabled={busy || readingFiles || documents.length > 0} onChange={e => { setFollowUp(e.target.checked); setManualRun(false); }} /> Use this run’s output previews as context</label>}
        {followUp && <p className="desk-hint">Starts a new run with the original permissions and checks. Context includes redacted output previews, not complete files.</p>}
        <details className="desk-instruction-preview"><summary>Task options</summary>{!manualRun && <ProjectModel token={token} projectId={projectId} disabled={busy} />}
          <label>Use a saved workflow’s boundaries<DataSelect aria-label="Workflow" value={workflowId} disabled={!projectId || busy || readingFiles || followUp || documents.length > 0} onValueChange={id => { chooseWorkflow(id); if (!id) setManualRun(false); }}><option value="">No tool access</option>{workflows.data?.map(w => <option key={w.id} value={w.id}>{w.definition.name}</option>)}</DataSelect></label>
          {selectedWorkflow && <WorkflowModels key={`${selectedWorkflow.id}:${selectedWorkflow.version}`} workflow={selectedWorkflow} token={token} disabled={busy || followUp} onSaved={async workflow => { await client.invalidateQueries({ queryKey: ["workflows"] }); setWorkflowId(workflow.id); }} />}
          {selectedWorkflow && <><label><input type="checkbox" checked={manualRun} disabled={busy || followUp} onChange={e => setManualRun(e.target.checked)} /> Run the saved workflow directly</label>{manualRun && <label>Task to update<DataSelect aria-label="Task to update" value={taskId} disabled={busy} onValueChange={setTaskId}><option value="">Choose task</option>{selectedWorkflow.definition.tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</DataSelect></label>}<p>{manualRun ? "Your instructions update the selected task; the full saved workflow runs." : "Bastion adapts task instructions while retaining every saved agent, permission, dependency, and verification check."}</p></>}
          {!selectedWorkflow && !documents.length && <p>Without connected sources or permissions, agents can work only with information you provide. Connect your project repository in Settings to reuse file access across tasks.</p>}
        </details>
        {health.isSuccess && health.data.runtimeConnected && !health.data.taskPlanningConnected && !manualRun && <p className="desk-hint">Automatic task planning is not connected. Use a saved workflow in Advanced.</p>}
        {health.isSuccess && !health.data.runtimeConnected && <p className="desk-hint">Agent runtime is offline. Connect it on the controller before starting a run.</p>}
      </form>}
    </section>
    {inspection && <dialog ref={inspectionDialog} className="desk-inspection-dialog" aria-labelledby="desk-review-title" onCancel={() => setInspection(null)} onClick={event => { if (event.target === event.currentTarget) setInspection(null); }}><section className="desk-inspector" aria-label="Run inspection">
      <div className="desk-pane-heading"><h2 id="desk-review-title">Run details</h2><button type="button" autoFocus className="desk-icon" aria-label="Close run details" onClick={() => setInspection(null)}><X /></button></div>
      <div className="desk-inspector-tabs" role="tablist" aria-label="Inspect run" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = tabs.indexOf(event.target as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.focus(); tabs[next]?.click();
      }}>{(["results", "security", "graph", "activity"] as const).map(view => <button id={`desk-tab-${view}`} role="tab" aria-selected={inspection === view} aria-controls="desk-inspection" tabIndex={inspection === view ? 0 : -1} key={view} onClick={() => setInspection(view)}>{view === "graph" ? "Trace" : view === "security" ? "Security" : view === "activity" ? "Activity" : "Results"}</button>)}</div>
      <div id="desk-inspection" role="tabpanel" aria-labelledby={`desk-tab-${inspection}`} className={`desk-inspector-body ${inspection === "graph" ? "desk-graph" : ""}`}>
        {inspection === "activity" ? <>          <div className="desk-section-label"><span>Recorded activity</span><Activity /></div>
          {!events.data?.length && <p className="desk-muted">No events recorded yet.</p>}
          {events.data?.map(e => <DetailDisclosure key={e.eventId} title={e.type.replaceAll(".", " · ").replaceAll("_", " ")}><p className="desk-hint">{new Date(e.timestamp).toLocaleString()}{e.taskId ? ` · ${s?.tasks[e.taskId]?.title || e.taskId}` : ""}</p><pre>{JSON.stringify(e.payload, null, 2)}</pre></DetailDisclosure>)}
          {s && events.data && events.data.length < s.lastSeq && <button className="desk-secondary" disabled={olderEventsBusy} onClick={async () => { setOlderEventsBusy(true); try { const known = events.data.map(e => e.seq); let after = 0; while (known.includes(after + 1)) after++; const batch = await api<NonNullable<typeof events.data>>(`/api/runs/${selectedRun}/events?after=${after}`, token); client.setQueryData(["events", selectedRun, token], (old: typeof events.data) => [...new Map([...(old || []), ...batch].map(e => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq)); } catch (failure) { setError(failure); } finally { setOlderEventsBusy(false); } }}>{olderEventsBusy ? "Loading…" : "Load missing events"}</button>}
</> : inspection === "graph" ? <section aria-label="Provenance graph"><div className="desk-trace-stage"><RunGraph snapshot={s} onSelect={setSelectedNode} interactiveOrbit /></div>{selectedNode && s && <DetailDisclosure title="Selected evidence"><pre>{JSON.stringify(s.sources[selectedNode] ?? s.artifacts[selectedNode] ?? s.toolRequests[selectedNode] ?? s.executions[selectedNode] ?? s.tasks[selectedNode] ?? { id: selectedNode }, null, 2)}</pre></DetailDisclosure>}</section> : !s ? <div className="desk-inspector-empty">{inspection === "security" ? <ShieldCheck /> : <FileText />}<h2>{inspection === "security" ? "A clear view of every decision" : "Work, ready to inspect"}</h2><p>{inspection === "security" ? "Select a run to inspect tool decisions, incidents, and recovery plans." : "Agent output and source previews will appear here when a run produces them."}</p></div> : inspection === "results" ? <>{!Object.keys(s.artifacts).length && <p className="desk-muted">No output artifacts recorded yet.</p>}{Object.values(s.artifacts).map(a => <DetailDisclosure key={a.id} title={a.name}><Response snapshot={s} artifact={a} token={token} animate={false} /><p className="desk-hint">Source references: {a.sourceIds.map(id => s.sources[id]?.name || id).join(", ") || "None"}</p><code>{a.contentHash}</code></DetailDisclosure>)}{Object.values(s.sources).length > 0 && <div className="desk-section-label">Sources</div>}{Object.values(s.sources).map(source => <DetailDisclosure key={source.id} title={source.name}><p>{source.preview}</p><small>{source.securityState} · {source.trust} · {source.classification}</small></DetailDisclosure>)}</> : <><RunEvidence snapshot={s} token={token} onTrace={() => setInspection("graph")} /><div className="desk-section-label">Tool decisions</div>{!Object.keys(s.toolRequests).length && <p className="desk-muted">No tool requests recorded.</p>}{Object.values(s.toolRequests).map(tool => <DetailDisclosure key={tool.id} title={tool.toolName}><p>{tool.decision || "Pending"}</p><code>{tool.resource}</code><p>{tool.reason}</p><small>{tool.policyRuleId}</small></DetailDisclosure>)}<div className="desk-section-label">Incidents & recovery</div><Incidents snapshot={s} token={token} refresh={() => client.invalidateQueries({ queryKey: ["run", selectedRun, token] })} /></>}
      </div>
      <div className="desk-inspector-foot"><ShieldCheck /><span>{s ? `${s.run.mode.toLowerCase()} · ${s.run.status.toLowerCase().replaceAll("_", " ")}` : "Awaiting a run"}</span>{s && <span>{s.lastSeq} events</span>}</div>
    </section></dialog>}
    {deleteTarget && <dialog ref={deleteDialog} className="desk-delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description" onCancel={event => { if (busy) event.preventDefault(); else setDeleteTarget(null); }}>
      <h2 id="delete-title">Delete {deleteTarget.kind === "projects" ? "project" : "run"}?</h2>
      <p className="desk-delete-name">{deleteTarget.name}</p>
      <p id="delete-description">{deleteTarget.kind === "projects" ? "This project and all its runs will disappear from your workspace." : "This run will disappear from your workspace."} Security audit records are retained. Active runs and arena sessions must finish first.</p>
      <ErrorBox error={deleteError} />
      <div className="desk-delete-actions"><button autoFocus className="desk-secondary" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</button><button className="desk-secondary desk-danger" disabled={busy} onClick={() => void deleteSelected()}>{busy ? "Deleting…" : "Delete"}</button></div>
    </dialog>}
    <footer className="desk-statusbar"><span>{token ? health.isError ? "Controller unavailable" : health.isPending ? "Checking controller…" : health.data?.runtimeConnected ? "Agent runtime connected" : "Agent runtime offline" : "Connect your controller to begin"}</span><span>{currentProject?.name}</span></footer>
    {settings && <dialog ref={settingsDialog} aria-label="Workspace settings" className="desk-settings-backdrop" onCancel={() => setSettings(false)} onClick={e => { if (e.target === e.currentTarget) setSettings(false); }}><section className="desk-settings" aria-label="Workspace settings"><div className="desk-pane-heading"><Settings2 /><h2>Workspace settings</h2><button autoFocus className="desk-icon" aria-label="Close settings" onClick={() => setSettings(false)}><X /></button></div><div className="desk-settings-content">{token && <Connections key={token} token={token} projectId={projectId} />}<details><summary>Controller status</summary><h3>Agent connection</h3><p>{!token ? "Connect with your operator token to check the controller." : health.data?.runtimeConnected ? "The controller reports an active agent runtime." : "The controller has not reported an active agent runtime."}</p><p>{provider.data?.runtime ? `${provider.data.runtime.provider} · ${provider.data.runtime.model}` : "No model configuration reported."}</p><p>Provider credentials remain on the controller. A connected runtime does not confirm available model credits.</p></details>{projectId && token && <ProjectRepository key={`${projectId}:${token}`} projectId={projectId} token={token} available={provider.data?.repositoryAvailable === true} />}<button className="desk-secondary" disabled={!projectId || !token} onClick={() => { setSetup(true); setSettings(false); }}><Bot /> Configure workflow</button><details className="desk-advanced"><summary><Settings2 /> Advanced</summary><p>Import an existing workflow definition into the selected project. Its agents, tasks, sources, and policies are validated before saving.</p><label className="desk-upload"><Upload /> Import workflow JSON<input aria-label="Import workflow JSON" type="file" accept=".json,application/json" disabled={!projectId || !token || busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label>{!projectId && <p className="desk-hint">Select a project first.</p>}<ErrorBox error={error} /></details></div></section></dialog>}
  </main>;
}
