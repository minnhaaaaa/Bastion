import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { ErrorBox } from "../ui";

export function RunPullRequest({ runId, token, completed }: { runId: string; token: string; completed: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const result = useQuery({ queryKey: ["run-pull-request", runId, token, completed], enabled: completed, queryFn: () => api<{ publication: { status: string; url: string | null; message: string | null } | null }>(`/api/runs/${runId}/pull-request`, token), refetchInterval: query => completed && ["WAITING", "PUBLISHING"].includes(query.state.data?.publication?.status ?? "") ? 2000 : false });
  const publication = result.data?.publication;
  if (!completed) return null;
  if (!publication) return result.error ? <ErrorBox error={result.error} /> : null;
  async function retry() { setBusy(true); setError(undefined); try { await api(`/api/runs/${runId}/pull-request`, token, {}); await result.refetch(); } catch (e) { setError(e); } finally { setBusy(false); } }
  return <section className="desk-approval" aria-label="GitHub pull request"><strong>GitHub pull request</strong><p>{publication.message ?? (completed ? "Preparing publication…" : "Approved edits will be published after the run passes its recorded checks.")}</p>
    {publication.url && <a className="desk-secondary" href={publication.url} target="_blank" rel="noopener noreferrer">Review pull request on GitHub</a>}
    {publication.status === "FAILED" && completed && <button className="desk-secondary" disabled={busy} onClick={() => void retry()}>{busy ? "Publishing…" : "Retry publishing"}</button>}
    <ErrorBox error={error} />
  </section>;
}
