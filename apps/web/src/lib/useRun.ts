import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import {
  applyEvent,
  type RunSnapshot,
  type RunEvent,
  type ServerToClientEvents,
  type ClientToServerEvents,
} from "@bastion/contracts";
import { api } from "./api";
import { env } from "../env";
export function useRun(runId: string | undefined, token: string) {
  const client = useQueryClient();
  const [connection, setConnection] = useState("Disconnected");
  const snapshot = useQuery({
    queryKey: ["run", runId, token],
    queryFn: () => api<RunSnapshot>(`/api/runs/${runId}`, token),
    enabled: !!runId && !!token,
  });
  const events = useQuery({
    queryKey: ["events", runId, token],
    queryFn: () => api<RunEvent[]>(`/api/runs/${runId}/events`, token),
    enabled: !!runId && !!token,
  });
  const ready = snapshot.isSuccess && events.isSuccess;
  useEffect(() => {
    if (!runId || !token || !ready) return;
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
      env.apiUrl,
      { auth: { token } },
    );
    socket.on("connect", () => {
      setConnection("Synchronizing");
      socket.emit("run.subscribe", { runId }, (response) => {
        setConnection(response.ok ? "Live" : response.error);
      });
    });
    socket.on("disconnect", () => setConnection("Reconnecting"));
    socket.on("connect_error", (error) => setConnection(error.message));
    socket.on("run.snapshot", (data) =>
      client.setQueryData(["run", runId, token], data),
    );
    socket.on("run.event", (event) => {
      try {
        client.setQueryData<RunSnapshot>(["run", runId, token], (previous) =>
          applyEvent(previous ?? null, event),
        );
        client.setQueryData<RunEvent[]>(["events", runId, token], (previous) =>
          [...(previous ?? []).filter((e) => e.seq !== event.seq), event].sort(
            (a, b) => a.seq - b.seq,
          ),
        );
      } catch {
        socket.emit("run.subscribe", { runId });
        void client.invalidateQueries({ queryKey: ["events", runId, token] });
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [runId, token, ready, client]);
  return { snapshot, events, connection };
}
