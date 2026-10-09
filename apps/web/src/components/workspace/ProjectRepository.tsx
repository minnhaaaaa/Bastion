import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { newId } from "@bastion/contracts";
import { api } from "../../lib/api";
import { ErrorBox } from "../ui";
import { DataSelect } from "../ui/data-select";

export type RepositoryView = { directory: string; connectedAt: string; sources: { name: string; location: string }[]; permissions: { operation: string; decision: string }[] };
export function ProjectRepository({ projectId, token, available }: { projectId: string; token: string; available: boolean }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["repository", projectId, token], queryFn: () => api<{ repository: RepositoryView | null }>(`/api/projects/${projectId}/repository`, token) });
  const [directory, setDirectory] = useState("");
  const [mode, setMode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function save(disconnect = false) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const permissions = [{ operation: "fs.read", decision: "ALLOW" }, ...(mode === "review-edits" ? [{ operation: "fs.write", decision: "REQUIRE_APPROVAL" }] : [])];
      await api(`/api/projects/${projectId}/repository`, token, { commandId: newId("command"), selection: disconnect ? null : { directory: directory.trim(), permissions } });
      await client.invalidateQueries({ queryKey: ["repository", projectId, token] });
      setDirectory(""); setMode("");
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <section className="desk-repository"><h3>Project repository</h3>
    {query.data?.repository ? <><p><code>{query.data.repository.directory}</code></p><p>{query.data.repository.sources.length} tracked files connected. {query.data.repository.permissions.some(p => p.operation === "fs.write") ? "Edits wait for your review." : "Read access only."}</p><details><summary>Connected files</summary><ul>{query.data.repository.sources.map(source => <li key={source.name}>{source.name}</li>)}</ul></details><p className="desk-hint">New tasks reuse this access. Saved workflows keep their own boundaries. Reconnect to refresh the tracked file list.</p><button className="desk-secondary" disabled={busy} onClick={() => void save(true)}>Disconnect repository</button><p className="desk-hint">Disconnecting affects new plans; existing workflows and runs retain their pinned permissions.</p></> : <p>Connect a repository once, then describe tasks without configuring individual agents.</p>}
    {available ? <form onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={busy}>
      <label>Repository path<input required value={directory} onChange={e => setDirectory(e.target.value)} autoComplete="off" /><span className="desk-hint">A Git repository already mounted inside the controller’s sandbox. Only tracked regular files are included.</span></label>
      <label>Access<DataSelect aria-label="Repository access" required value={mode} onValueChange={setMode} disabled={busy}><option value="" disabled>Choose access</option><option value="read">Read files</option><option value="review-edits">Read files · review every edit</option></DataSelect></label>
      <p className="desk-hint">Connected file contents are sent to your configured model when a task runs. Repository text is treated as untrusted, internal data. Commands, network access, and new files require separate permissions.</p>
      <button className="desk-primary" disabled={busy || !directory.trim() || !mode}>{busy ? "Connecting…" : "Connect repository"}</button>
    </fieldset></form> : <p className="desk-hint">The controller needs its repository connector enabled before you can connect files.</p>}
    <ErrorBox error={error || query.error} />
  </section>;
}
