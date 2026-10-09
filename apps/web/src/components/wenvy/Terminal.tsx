import { useQuery } from "@tanstack/react-query";
import type { RunSummary, RunEvent } from "@bastion/contracts";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
// The Wenvy terminal shell, backed by Bastion's event journal instead of a canned script.
export function Terminal() {
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
  return (
    <div className="term">
      <div className="term__bar">
        <span />
        <span />
        <span />
        <b>event journal</b>
      </div>
      <div className="term__body">
        {events.data?.length ? (
          events.data.slice(-8).map((event) => (
            <div className="term-event" key={event.eventId}>
              <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
              <span>{event.type}</span>
            </div>
          ))
        ) : (
          <div className="term-empty">
            <span className="term-symbol" aria-hidden="true">
              ↳
            </span>
            <span>
              {runs.isError || events.isError
                ? "Connection unavailable"
                : token && (runs.isPending || (!!runId && events.isPending))
                  ? "Connecting…"
                  : "No run selected"}
            </span>
            <a className="btn btn--invert" href="/dashboard">
              open console ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
