import { useConnections } from "./Connections";
import { useState } from "react";
import { AgentRole, SourceTrust, Classification, PolicyDecision, newId, type Workflow } from "@bastion/contracts";
import { Plus, Trash2, Bot, GitBranch, FileText, ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { workflowFromForm, type DraftRows } from "../../lib/workflow-draft";
import { ErrorBox } from "../ui";
import { DataSelect } from "../ui/data-select";

export function WorkflowSetup({ projectId, token, onSaved }: { projectId: string; token: string; onSaved: (workflow: Workflow) => void }) {
  const connections = useConnections(token);
  const [models, setModels] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<DraftRows>({ agents: [], tasks: [], sources: [], rules: [] });
  const [names, setNames] = useState<Record<string, string>>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  const selectValue = (key: string, value: string) => setSelections(previous => ({ ...previous, [key]: value }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  function add(kind: keyof DraftRows) {
    const id = newId(kind === "agents" ? "agent" : kind === "tasks" ? "task" : kind === "sources" ? "source" : "command");
    setRows(previous => ({ ...previous, [kind]: [...previous[kind], id] }));
  }
  function remove(kind: keyof DraftRows, id: string) { setRows(previous => ({ ...previous, [kind]: previous[kind].filter(row => row !== id) })); }
  const removeButton = (kind: keyof DraftRows, id: string) => <button type="button" className="desk-icon" aria-label={`Remove ${kind === "agents" ? "agent" : kind === "tasks" ? "task" : kind === "sources" ? "source" : "rule"}`} onClick={() => remove(kind, id)}><Trash2 /></button>;
  return <form className="desk-setup" onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setError(undefined); setBusy(true);
    try {
      const definition = workflowFromForm(form, rows);
      const workflow = await api<Workflow>("/api/workflows", token, { commandId: newId("command"), projectId, definition, agentConnections: Object.fromEntries(rows.agents.filter(id => models[id]).map(id => [id, models[id]])) });
      onSaved(workflow);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }}>
    <div className="desk-section-heading"><div><h2>Configure a workflow</h2><p>Define your agents, tasks, and the boundaries they work within.</p></div></div>
    <fieldset disabled={busy}>
      <label>Workflow name<input name="name" required autoComplete="off" /></label>
      <div className="desk-section-heading"><h3><Bot /> Agents</h3><button type="button" className="desk-subtle" onClick={() => add("agents")}><Plus /> Add agent</button></div>
      {!rows.agents.length && <p className="desk-hint">Add an agent and explicitly grant its capabilities. No capabilities means no tool access.</p>}
      {rows.agents.map(id => <div className="desk-config-card" key={id}>
        <div className="desk-row"><code>{id}</code>{removeButton("agents", id)}</div>
        <label>Role<DataSelect aria-label="Role" name={`${id}.role`} value={selections[`${id}.role`] || ""} disabled={busy} required onValueChange={value => { selectValue(`${id}.role`, value); setNames(n => ({ ...n, [id]: value })); }}><option value="" disabled>Choose a role</option>{AgentRole.options.map(role => <option key={role} value={role}>{role}</option>)}</DataSelect></label>
        {connections.data?.enabled && <label>Model<DataSelect aria-label="Agent model" value={models[id] || "project"} disabled={busy} onValueChange={value => setModels(previous => ({ ...previous, [id]: value === "project" ? "" : value }))}><option value="project">Use project model</option>{connections.data.connections.filter(connection => !connection.disabled).map(connection => <option key={connection.id} value={connection.id}>{connection.label} · {connection.model}</option>)}</DataSelect></label>}
        <label>Capabilities<textarea name={`${id}.capabilities`} rows={2} aria-describedby={`help-${id}`} /></label>
        <p id={`help-${id}`} className="desk-hint">One per line: domain.operation:resource-glob. Only grant access this agent needs.</p>
      </div>)}
      <div className="desk-section-heading"><h3><FileText /> Sources</h3><button type="button" className="desk-subtle" onClick={() => add("sources")}><Plus /> Add source</button></div>
      {rows.sources.map(id => <div className="desk-config-card" key={id}>
        <div className="desk-row"><h4>Source</h4>{removeButton("sources", id)}</div>
        <label>Name<input name={`${id}.name`} required onChange={e => setNames(n => ({ ...n, [id]: e.target.value.trim() }))} /></label>
        <label>Location<input name={`${id}.location`} required /><span className="desk-hint">Path or URL accessible to the controller sandbox.</span></label>
        <div className="desk-form-grid"><label>Trust<DataSelect aria-label="Trust" name={`${id}.trust`} value={selections[`${id}.trust`] || ""} disabled={busy} required onValueChange={value => selectValue(`${id}.trust`, value)}><option value="" disabled>Choose trust</option>{SourceTrust.options.map(value => <option key={value} value={value}>{value}</option>)}</DataSelect></label><label>Classification<DataSelect aria-label="Classification" name={`${id}.classification`} value={selections[`${id}.classification`] || ""} disabled={busy} required onValueChange={value => selectValue(`${id}.classification`, value)}><option value="" disabled>Choose classification</option>{Classification.options.map(value => <option key={value} value={value}>{value}</option>)}</DataSelect></label></div>
      </div>)}
      <div className="desk-section-heading"><h3><GitBranch /> Tasks</h3><button type="button" className="desk-subtle" onClick={() => add("tasks")}><Plus /> Add task</button></div>
      {rows.tasks.map(id => <div className="desk-config-card" key={id}>
        <div className="desk-row"><h4>Task</h4>{removeButton("tasks", id)}</div>
        <label>Instructions<textarea name={`${id}.title`} rows={3} required onChange={e => setNames(n => ({ ...n, [id]: e.target.value }))} /></label>
        <label>Agent<DataSelect aria-label="Agent" name={`${id}.agent`} value={rows.agents.includes(selections[`${id}.agent`] || "") ? selections[`${id}.agent`]! : ""} disabled={busy} required onValueChange={value => selectValue(`${id}.agent`, value)}><option value="" disabled>Assign an agent</option>{rows.agents.map(agent => <option key={agent} value={agent}>{names[agent] || "Agent"} · {agent}</option>)}</DataSelect></label>
        <div className="desk-form-grid"><label>Output artifact name<input name={`${id}.produces`} required /></label><label>Maximum attempts<input name={`${id}.attempts`} type="number" min={1} step={1} required /></label></div>
        <label className="desk-check"><input name={`${id}.idempotent`} type="checkbox" /> Safe to retry without duplicate effects</label>
        {!!rows.sources.length && <fieldset><legend>Read sources</legend>{rows.sources.map(source => <label className="desk-check" key={source}><input name={`${id}.sources`} type="checkbox" value={names[source] || ""} disabled={!names[source]} />{names[source] || "Name the source first"}</label>)}</fieldset>}
        {rows.tasks.length > 1 && <fieldset><legend>Wait for tasks</legend>{rows.tasks.filter(task => task !== id).map(task => <label className="desk-check" key={task}><input name={`${id}.deps`} type="checkbox" value={task} />{names[task] || task}</label>)}</fieldset>}
      </div>)}
      <div className="desk-section-heading"><h3><ShieldCheck /> Security rules</h3><button type="button" className="desk-subtle" onClick={() => add("rules")}><Plus /> Add rule</button></div>
      <p className="desk-hint">Capabilities bound access. Rules can deny actions or require your approval before execution.</p>
      {rows.rules.map(id => <div className="desk-config-card" key={id}>
        <div className="desk-row"><h4>Policy rule</h4>{removeButton("rules", id)}</div>
        <label>Description<input name={`${id}.description`} required /></label>
        <div className="desk-form-grid"><label>Operation<input name={`${id}.operation`} required /></label><label>Decision<DataSelect aria-label="Decision" name={`${id}.decision`} value={selections[`${id}.decision`] || ""} disabled={busy} required onValueChange={value => selectValue(`${id}.decision`, value)}><option value="" disabled>Choose a decision</option>{PolicyDecision.options.map(value => <option key={value} value={value}>{value}</option>)}</DataSelect></label></div>
        <label>Resource pattern<input name={`${id}.resource`} required /></label>
      </div>)}
      <ErrorBox error={error} />
      <button className="desk-primary" disabled={busy || !rows.agents.length || !rows.tasks.length}>{busy ? "Saving…" : "Save workflow"}</button>
    </fieldset>
  </form>;
}
