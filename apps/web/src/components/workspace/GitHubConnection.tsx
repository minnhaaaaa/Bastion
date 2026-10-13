import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { ErrorBox } from "../ui";

export function GitHubConnection({ token }: { token: string }) {
  const client = useQueryClient();
  const connection = useQuery({ queryKey: ["github-connection", token], queryFn: () => api<{ configured: boolean; scope?: string; connection: { login: string } | null }>("/api/github/connection", token) });
  const [attempt, setAttempt] = useState<{ attemptId: string; authorizationUrl: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const status = useQuery({ queryKey: ["github-attempt", token, attempt?.attemptId], queryFn: () => api<{ status: string; login?: string; error?: string }>(`/api/github/attempts/${attempt!.attemptId}`, token), enabled: !!attempt, refetchOnWindowFocus: "always" });
  async function action(work: () => Promise<void>) { setBusy(true); setError(undefined); try { await work(); await client.invalidateQueries({ queryKey: ["github-connection", token] }); } catch (e) { setError(e); } finally { setBusy(false); } }
  function signIn() {
    // Open synchronously from the click so browsers do not block the authorization window.
    const popup = window.open("about:blank", "_blank", "popup");
    if (popup) popup.opener = null;
    void action(async () => {
      try {
        const next = await api<{ attemptId: string; authorizationUrl: string }>("/api/github/start", token, {});
        setAttempt(next);
        if (popup && !popup.closed) popup.location.replace(next.authorizationUrl);
      } catch (error) { popup?.close(); throw error; }
    });
  }
  return <section aria-label="GitHub account"><h4>GitHub account</h4>
    {connection.data?.connection && <p>Connected as <strong>{connection.data.connection.login}</strong></p>}
    {connection.data && !connection.data.configured ? <p className="desk-hint">GitHub sign-in is not set up for this Bastion installation yet. The app administrator must register Bastion with GitHub and configure its OAuth client ID, client secret, and callback URL once. After setup, users connect through the GitHub permission popup; they do not enter tokens.</p> : <>
      <p className="desk-hint">Sign in to authorize repository publishing. {connection.data?.scope === "repo" ? "GitHub will request access to public and private repositories." : "GitHub will request access to public repositories."}</p>
      <button type="button" className="desk-secondary" disabled={busy || !connection.data?.configured} onClick={signIn}>Connect GitHub</button>
      {connection.data?.connection && <button type="button" className="desk-subtle" disabled={busy} onClick={() => void action(async () => { await api("/api/github/disconnect", token, {}); setAttempt(undefined); })}>Disconnect GitHub</button>}
    </>}
    {attempt && <div aria-live="polite">
      {(!status.data || ["pending", "exchanging"].includes(status.data.status)) && <><a href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer" className="desk-secondary">Continue on GitHub</a><button type="button" className="desk-subtle" onClick={() => void status.refetch()}>Check sign-in</button></>}
      {status.data?.status === "confirm" && <><p>GitHub account: <strong>{status.data.login}</strong></p><button type="button" className="desk-primary" disabled={busy} onClick={() => void action(async () => { await api(`/api/github/attempts/${attempt.attemptId}/complete`, token, {}); setAttempt(undefined); })}>Connect this account</button></>}
      {status.data?.error && <p role="alert">{status.data.error}</p>}
    </div>}
    {connection.data?.connection && <p className="desk-hint">Disconnect removes the stored credential from Bastion. You can revoke the app’s authorization in GitHub settings.</p>}
    <ErrorBox error={error || connection.error || status.error} />
  </section>;
}
