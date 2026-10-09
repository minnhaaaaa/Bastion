import { useQuery } from "@tanstack/react-query";
import type { RunEvent, RunSummary } from "@bastion/contracts";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";

/** Live tail of the most recent run's event journal. Real API data only; empty state otherwise. */
export function SignalLog() {
  const { token } = useSession();
  const runs = useQuery({
    queryKey: ["runs", token],
    queryFn: () => api<RunSummary[]>("/api/runs", token),
    enabled: !!token,
  });
  const runId = runs.data?.[0]?.id;
  const events = useQuery({
    queryKey: ["landing-events", runId, token],
    queryFn: () => api<RunEvent[]>(`/api/runs/${runId}/events`, token),
    enabled: !!runId && !!token,
    refetchInterval: 5000,
  });
  const status = runs.isError || events.isError
    ? "link unavailable"
    : token && (runs.isPending || (!!runId && events.isPending))
      ? "acquiring signal…"
      : token
        ? "no runs recorded yet"
        : "operator not connected";
  return (
    <div className="signal-log">
      <div className="signal-log__bar">
        <span className="signal-log__dot" aria-hidden="true" />
        <b>Event journal</b>
        <span>{runId ?? "—"}</span>
      </div>
      <div className="signal-log__body" aria-live="polite">
        {events.data?.length ? (
          events.data.slice(-9).map((event) => (
            <div className={`signal-log__row ${/denied|DENY|incident|quarantin/i.test(event.type + JSON.stringify(event.payload)) ? "is-alert" : ""}`} key={event.eventId}>
              <span className="signal-log__seq">{String(event.seq).padStart(4, "0")}</span>
              <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
              <span className="signal-log__type">{event.type}</span>
            </div>
          ))
        ) : (
          <div className="signal-log__empty">
            <span>{status}</span>
            <a className="btn btn--ghost" href="/dashboard">
              Open console <span aria-hidden="true">↗</span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
