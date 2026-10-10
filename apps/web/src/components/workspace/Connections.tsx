import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plug, ExternalLink } from "lucide-react";
import { api } from "../../lib/api";
import { DataSelect } from "../ui/data-select";
import { ErrorBox } from "../ui";

export type ModelConnection = { id: string; label: string; provider: string; model: string; authMode: string; disabled: boolean };
export type ConnectionsView = { enabled: boolean; chatgptAvailable: boolean; connections: ModelConnection[]; catalog: { provider: string; id: string; name: string }[]; controller: { provider: string; model: string } | null };
export function useConnections(token: string) {
  return useQuery({ queryKey: ["connections", token], queryFn: () => api<ConnectionsView>("/api/provider-connections", token), enabled: !!token });
}
export function useProjectModel(token: string, projectId: string) {
  return useQuery({ queryKey: ["project-model", projectId, token], queryFn: () => api<{ connectionId: string | null }>(`/api/projects/${projectId}/model`, token), enabled: !!token && !!projectId });
}
export function ProjectModel({ token, projectId, disabled = false }: { token: string; projectId: string; disabled?: boolean }) {
  const connections = useConnections(token), selection = useProjectModel(token, projectId), client = useQueryClient();
  const [saving, setSaving] = useState(false), [error, setError] = useState<unknown>();
  const available = connections.data?.connections.filter(item => !item.disabled) ?? [];
  const value = available.some(item => item.id === selection.data?.connectionId) ? selection.data!.connectionId! : "";
  if (!connections.data?.enabled || !projectId) return null;
  return <div className="desk-model-choice"><label>Project model<DataSelect aria-label="Project model" value={value} disabled={disabled || saving || selection.isPending} onValueChange={async connectionId => {
    setSaving(true); setError(undefined);
    try { await api(`/api/projects/${projectId}/model`, token, { connectionId }); await client.invalidateQueries({ queryKey: ["project-model", projectId, token] }); }
    catch (failure) { setError(failure); } finally { setSaving(false); }
  }}><option value="" disabled>{available.length ? "Choose a connected model" : "Add a connection first"}</option>{available.map(item => <option key={item.id} value={item.id}>{item.label} · {item.model}</option>)}</DataSelect></label><ErrorBox error={error || selection.error} /></div>;
}
export function Connections({ token, projectId }: { token: string; projectId: string }) {
  const query = useConnections(token), client = useQueryClient();
  const [provider, setProvider] = useState(""), [model, setModel] = useState(""), [label, setLabel] = useState(""), [key, setKey] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [notice, setNotice] = useState("");
  const [method, setMethod] = useState<"chatgpt" | "api-key">("chatgpt");
  const [attempt, setAttempt] = useState<{ attemptId: string; authorizationUrl?: string } | undefined>(() => { const attemptId = sessionStorage.getItem("bastion-chatgpt-attempt"); return attemptId ? { attemptId } : undefined; }), [accountModel, setAccountModel] = useState("");
  useEffect(() => { if (attempt) sessionStorage.setItem("bastion-chatgpt-attempt", attempt.attemptId); else sessionStorage.removeItem("bastion-chatgpt-attempt"); }, [attempt]);
  const status = useQuery({ queryKey: ["chatgpt-sign-in", attempt?.attemptId, token], queryFn: () => api<{ status: string; models?: { id: string; name: string }[]; error?: string }>(`/api/provider-connections/chatgpt/${attempt!.attemptId}`, token), enabled: !!attempt, refetchInterval: query => query.state.error || ["failed", "connected", "choose-model"].includes(query.state.data?.status ?? "") ? false : 2000 });
  const data = query.data, providers = [...new Set(data?.catalog.map(item => item.provider))].sort();
  const models = data?.catalog.filter(item => item.provider === provider) ?? [];
  async function action(work: () => Promise<void>) { setBusy(true); setError(undefined); setNotice(""); try { await work(); await client.invalidateQueries({ queryKey: ["connections", token] }); } catch (failure) { setError(failure); } finally { setBusy(false); setKey(""); } }
  async function signIn(connection?: ModelConnection) {
    setMethod("chatgpt");
    await action(async () => { setAccountModel(""); setAttempt(await api("/api/provider-connections/chatgpt/start", token, { label: connection?.label ?? label.trim(), ...(connection ? { connectionId: connection.id } : {}) })); });
  }
  return <section className="desk-connections" aria-label="Model connections"><h3><Plug /> Model connections</h3><p>Connect once, choose a project model, and give your agents a task. Permissions and approvals apply across providers.</p><ErrorBox error={error || query.error || status.error} />
    {query.isPending && <p role="status">Loading connections…</p>}
    {data && !data.enabled && <p>Connection storage is not enabled. Set PROVIDER_CREDENTIAL_KEY on the controller to enable secure connections.</p>}
    {data?.enabled && <>

      <div className="desk-connection-form">
        <h4>Add a model connection</h4>
        <div className="desk-row" role="group" aria-label="Connection method">
          {data.chatgptAvailable && <button type="button" className="desk-secondary" aria-pressed={method === "chatgpt"} onClick={() => { setMethod("chatgpt"); setKey(""); }}>ChatGPT account</button>}
          <button type="button" className="desk-secondary" aria-pressed={method === "api-key" || !data.chatgptAvailable} onClick={() => setMethod("api-key")}><KeyRound /> Provider API key</button>
        </div>
        <label>Connection name<input value={label} onChange={e => setLabel(e.target.value)} maxLength={120} disabled={busy} /></label>
        {method === "chatgpt" && data.chatgptAvailable ? <>
          <p>Sign in, return here, and choose a ChatGPT model. Your connection is saved only after you choose the model.</p>
          <button type="button" className="desk-secondary" disabled={busy || !label.trim()} onClick={() => void signIn()}>{attempt ? "Start a new ChatGPT sign-in" : "Continue with ChatGPT"} <ExternalLink /></button>
      {attempt && method === "chatgpt" && <div className="desk-config-card" aria-live="polite">{(!status.data || status.data.status === "pending") && <>{attempt.authorizationUrl && <a className="desk-secondary" href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in <ExternalLink /></a>}<p>Finish authorization in the sign-in tab, then choose your account model here.</p></>}{status.data?.status === "exchanging" && <p>Validating the account and loading available models…</p>}{status.data?.error && <p role="alert">{status.data.error}</p>}{status.data?.status === "choose-model" && <><p>Account authorized. Choose a model to finish connecting.</p><label>Available account model<DataSelect aria-label="ChatGPT account model" value={accountModel} disabled={busy} onValueChange={setAccountModel}><option value="" disabled>Choose an account model</option>{status.data.models?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</DataSelect></label><button className="desk-secondary" disabled={busy || !accountModel} onClick={() => void action(async () => { await api(`/api/provider-connections/chatgpt/${attempt.attemptId}/complete`, token, { model: accountModel }); setAttempt(undefined); setNotice("ChatGPT connected. Choose this connection as your project model."); })}>Save ChatGPT connection</button></>}</div>}
        </> : <form onSubmit={e => { e.preventDefault(); void action(async () => {
          await api("/api/provider-connections", token, { label: label.trim(), provider, model, apiKey: key.trim() });
          setNotice("API-key connection saved. Choose it as your project model. Model access and quota are checked when you run a task."); setLabel(""); setModel("");
        }); }}>
          <p>Choose anthropic for Claude, deepseek for DeepSeek, moonshotai for Kimi, or kimi-coding for a Kimi Coding key. Other supported providers are also listed below.</p>
          <div className="desk-form-grid"><label>Provider<DataSelect aria-label="Provider" value={provider} disabled={busy} onValueChange={value => { setProvider(value); setModel(""); setKey(""); }}><option value="" disabled>Choose a provider</option>{providers.map(name => <option key={name} value={name}>{name}</option>)}</DataSelect></label>
          <label>Model<DataSelect aria-label="Provider model" value={model} disabled={busy || !provider} onValueChange={setModel}><option value="" disabled>Choose a model</option>{models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</DataSelect></label></div>
          <label>API key<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} required disabled={busy || !provider} /></label>
          <p>Use a key from the selected provider’s developer console. A Claude Code subscription is separate from an Anthropic API key. Keys are encrypted on this controller.</p>
          {provider && model && <p>Connecting to <strong>{provider}</strong> · <code>{model}</code></p>}
          <button type="submit" className="desk-secondary" disabled={busy || !key.trim() || !model || !label.trim()}>Save API-key connection</button>
        </form>}
      </div>
      {data.controller && <details><summary>Advanced · reuse controller credentials</summary><p>This creates another API-key connection to <strong>{data.controller.provider}</strong> · {data.controller.model}. It does not connect a ChatGPT account.</p><button type="button" className="desk-subtle" disabled={busy} onClick={() => void action(async () => { await api("/api/provider-connections/controller", token, { label: `${data.controller!.provider} · ${data.controller!.model}` }); setNotice("Controller API-key connection saved."); })}>Import {data.controller.provider} connection</button></details>}
      <h4>Saved connections</h4>
      <div className="desk-connection-list">{data.connections.filter(item => !item.disabled).map(item => <article className="desk-config-card" key={item.id}><div className="desk-row"><strong>{item.label}</strong><button type="button" className="desk-subtle" disabled={busy} onClick={() => void action(async () => { await api(`/api/provider-connections/${item.id}/disable`, token, {}); setNotice("Connection disabled in Bastion. Already running requests may finish. Provider-side authorization is unchanged."); })}>Disable</button></div><code>{item.provider} · {item.model}</code><small>{item.authMode === "chatgpt" ? "Signed in with ChatGPT" : `API key · ${item.provider}`} · Usage limits apply</small>{item.authMode === "chatgpt" && data.chatgptAvailable && <button type="button" className="desk-subtle" disabled={busy} onClick={() => void signIn(item)}>Sign in again</button>}</article>)}</div>
      {notice && <p role="status">{notice}</p>}
      {projectId ? <><ProjectModel token={token} projectId={projectId} disabled={busy} /><p>New tasks use this model. Saved workflows retain their assignments; optional agent overrides are in Advanced workflows.</p></> : <p>After connecting, select or create a project in the sidebar.</p>}
    </>}
  </section>;
}
