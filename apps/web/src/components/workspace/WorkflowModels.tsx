import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { newId, type Workflow } from "@bastion/contracts";
import { api } from "../../lib/api";
import { DataSelect } from "../ui/data-select";
import { ErrorBox } from "../ui";
import { useConnections } from "./Connections";

export function WorkflowModels({ workflow, token, disabled, onSaved }: { workflow: Workflow; token: string; disabled: boolean; onSaved(workflow: Workflow): Promise<void> }) {
  const connections = useConnections(token);
  const assigned = useQuery({ queryKey: ["workflow-models", workflow.id, workflow.version, token], queryFn: () => api<{ bindings: Record<string, string> }>(`/api/workflows/${workflow.id}/models?version=${workflow.version}`, token) });
  const [changes, setChanges] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  if (!connections.data?.enabled) return null;
  const available = connections.data.connections.filter(item => !item.disabled);
  return <details className="desk-workflow-models"><summary>Optional agent models</summary><p>Use different providers for different agents. Saving creates a workflow version and preserves every task, permission, and check.</p><ErrorBox error={error || assigned.error} />
    {workflow.definition.agents.map(agent => { const id = changes[agent.id] ?? assigned.data?.bindings[agent.id] ?? ""; return <label key={agent.id}>{agent.role} · {agent.id}<DataSelect aria-label={`Model for ${agent.id}`} value={available.some(item => item.id === id) ? id : ""} disabled={disabled || busy || assigned.isPending} onValueChange={connectionId => setChanges(previous => ({ ...previous, [agent.id]: connectionId }))}><option value="" disabled>Choose a connected model</option>{available.map(item => <option key={item.id} value={item.id}>{item.label} · {item.model}</option>)}</DataSelect></label>; })}
    <button type="button" className="desk-secondary" disabled={disabled || busy || !Object.keys(changes).length} onClick={async () => { setBusy(true); setError(undefined); try { const result = await api<Workflow>(`/api/workflows/${workflow.id}/versions`, token, { commandId: newId("command"), definition: workflow.definition, agentConnections: changes }); await onSaved(result); setChanges({}); } catch (failure) { setError(failure); } finally { setBusy(false); } }}>Save model assignments</button>
  </details>;
}
