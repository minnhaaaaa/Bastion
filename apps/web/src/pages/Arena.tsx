import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import QRCode from "qrcode";
import barba from "@barba/core";
import {
  newId,
  type CreateRoomResult,
  type JoinRoomResult,
  type ArenaPhaseUpdate,
  type RoomPresence,
  type PlayerPrivateState,
  type ActionResult,
  type ArenaReveal,
  type ServerToClientEvents,
  type ClientToServerEvents,
} from "@bastion/contracts";
import SliceBlade from "../components/originkit/ui/slice-blade";
import {
  Arrow,
  Button,
  Connect,
  Empty,
  ErrorBox,
  Header,
  useReducedMotion,
} from "../components/ui";
import { RunGraph } from "../components/RunGraph";
import { api } from "../lib/api";
import { env } from "../env";
import { useSession } from "../lib/session";
import { useRun } from "../lib/useRun";
type RoomSession = {
  token: string;
  kind: "host" | "player";
  joinCode?: string;
};
const sessions = new Map<string, RoomSession>();
type PublicRoom = ArenaPhaseUpdate & { presence: RoomPresence };
export function Arena({ roomId }: { roomId?: string }) {
  const reduced = useReducedMotion();
  const { token } = useSession();
  const [session, setSession] = useState(
    roomId ? sessions.get(roomId) : undefined,
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult>();
  const [reveal, setReveal] = useState<ArenaReveal>();
  const [qr, setQr] = useState("");
  const [clock, setClock] = useState(Date.now());
  const client = useQueryClient();
  const room = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api<PublicRoom>(`/api/arena/rooms/${roomId}`),
    enabled: !!roomId,
    refetchInterval: 3000,
  });
  const me = useQuery({
    queryKey: ["me", roomId, session?.token],
    queryFn: () =>
      api<PlayerPrivateState>(`/api/arena/rooms/${roomId}/me`, session?.token),
    enabled: session?.kind === "player",
    refetchInterval: 3000,
  });
  const options = useQuery({
    queryKey: ["attack-options", roomId, session?.token],
    queryFn: () =>
      api<
        { id: string; card: string; label: string; targetSourceName: string }[]
      >(`/api/arena/rooms/${roomId}/attack-options`, session?.token),
    enabled: me.data?.role === "ATTACKER" && room.data?.phase !== "LOBBY",
  });
  const { snapshot, connection } = useRun(
    room.data?.runId ?? undefined,
    session?.token ?? "",
  );
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!roomId || !session) return;
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
      env.apiUrl,
      { auth: { token: session.token } },
    );
    socket.on("connect", () =>
      socket.emit("room.subscribe", { roomId }, (ack) => {
        if (!ack.ok) setError(new Error(ack.error));
      }),
    );
    socket.on("arena.phase", (update) => {
      client.setQueryData<PublicRoom>(["room", roomId], (old) =>
        old ? { ...old, ...update } : old,
      );
    });
    socket.on("room.presence", (presence) => {
      client.setQueryData<PublicRoom>(["room", roomId], (old) =>
        old ? { ...old, presence } : old,
      );
    });
    socket.on("player.private_state", (state) =>
      client.setQueryData(["me", roomId, session.token], state),
    );
    socket.on("action.result", setResult);
    socket.on("arena.reveal", setReveal);
    socket.on("connect_error", setError);
    return () => {
      socket.disconnect();
    };
  }, [roomId, session, client]);
  const joinUrl =
    roomId && session?.joinCode
      ? `${window.location.origin}/arena/${encodeURIComponent(roomId)}?code=${encodeURIComponent(session.joinCode)}`
      : "";
  useEffect(() => {
    let alive = true;
    if (joinUrl)
      QRCode.toDataURL(joinUrl, {
        color: { dark: "#000000", light: "#ffffff" },
        margin: 2,
        width: 180,
      })
        .then((value) => {
          if (alive) setQr(value);
        })
        .catch(setError);
    return () => {
      alive = false;
    };
  }, [joinUrl]);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  // Navigate through Barba so in-memory room credentials survive the transition.
  async function createRoom(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await perform(async () => {
      const data = await api<CreateRoomResult>("/api/arena/rooms", token, {
        commandId: newId("command"),
        workflowId: form.get("workflowId"),
      });
      sessions.set(data.roomId, {
        token: data.hostToken,
        kind: "host",
        joinCode: data.joinCode,
      });
      barba.go(`/arena/${data.roomId}`);
    });
  }
  function join(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void perform(async () => {
      const data = await api<JoinRoomResult>(
        `/api/arena/rooms/${roomId}/join`,
        "",
        {
          commandId: newId("command"),
          joinCode: form.get("joinCode"),
          displayAlias: form.get("alias"),
        },
      );
      const next: RoomSession = { token: data.playerToken, kind: "player" };
      sessions.set(roomId!, next);
      setSession(next);
    });
  }
  async function hostAction(action: "start" | "reveal") {
    await perform(async () => {
      const data = await api<ArenaPhaseUpdate | ArenaReveal>(
        `/api/arena/rooms/${roomId}/${action}`,
        session?.token,
        { commandId: newId("command") },
      );
      if (action === "reveal") setReveal(data as ArenaReveal);
      await room.refetch();
    });
  }
  const remaining = room.data?.phaseEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (Date.parse(room.data.phaseEndsAt) -
            (Date.parse(room.data.serverNow) + clock - room.dataUpdatedAt)) /
            1000,
        ),
      )
    : null;
  return (
    <>
      <Header active="arena" />
      <main id="main" tabIndex={-1} className="arena-page container">
        <div className="arena-heading">
          <div>
            <span className="eyebrow">BASTION / ADVERSARIAL PLAYGROUND</span>
            <h1>
              The <em>Arena.</em>
            </h1>
          </div>
          <span className="arena-label mono">
            {room.data
              ? room.data.phase.replaceAll("_", " ")
              : "ATTACK THE INPUT. DEFEND THE OUTCOME."}
          </span>
        </div>
        <ErrorBox
          error={
            error || room.error || me.error || options.error || snapshot.error
          }
        />
        {!roomId ? (
          <>
            <div className="arena-entry">
              <div className="arena-entry-copy">
                <h2>
                  One workflow.
                  <br />
                  Two sides.
                  <br />
                  <em>Every move matters.</em>
                </h2>
                <p>
                  Join a sandboxed agent workflow. Plant a poisoned input, or
                  follow the evidence and contain it. The mission: keep the
                  legitimate work moving.
                </p>
                <form
                  className="join-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    const id = String(data.get("roomId")).trim();
                    if (id) barba.go(`/arena/${encodeURIComponent(id)}`);
                  }}
                >
                  <label htmlFor="room-id">Have a room invitation?</label>
                  <div className="inline-form">
                    <input
                      id="room-id"
                      name="roomId"
                      required
                      placeholder="Room ID"
                    />
                    <Button type="submit">
                      Join room <Arrow />
                    </Button>
                  </div>
                </form>
              </div>
              <div className="slice-panel">
                <span className="eyebrow">WARM-UP / SLICE BLADE</span>
                {reduced ? (
                  <div className="slice-still">ARENA</div>
                ) : (
                  <SliceBlade
                    title="BASTION"
                    ink="#ffffff"
                    accent="#9281f7"
                    background="#000000"
                    style={{
                      minWidth: 0,
                      minHeight: 0,
                      width: "100%",
                      height: 340,
                    }}
                  />
                )}
                <p className="mono">
                  Drag to slice. A separate visual warm-up, not the security
                  round.
                </p>
              </div>
            </div>
            <section className="host-setup">
              <span className="eyebrow">HOST A SECURITY ROUND</span>
              {!token ? (
                <Connect />
              ) : (
                <form onSubmit={(e) => void createRoom(e)}>
                  <h2>Bring your workflow.</h2>
                  <p>
                    Create a room from a workflow already registered in your
                    workspace.
                  </p>
                  <label htmlFor="host-workflow">Workflow ID</label>
                  <div className="inline-form">
                    <input
                      id="host-workflow"
                      name="workflowId"
                      required
                      pattern="wf_.+"
                    />
                    <Button disabled={busy} type="submit">
                      Create room <Arrow />
                    </Button>
                  </div>
                </form>
              )}
            </section>
          </>
        ) : (
          <>
            <div className="round-bar">
              <div>
                <span className="eyebrow">ROOM</span>
                <strong className="mono">{roomId}</strong>
              </div>
              <div>
                <span className="eyebrow">PARTICIPANTS</span>
                <strong>{room.data?.presence.count ?? "—"}</strong>
              </div>
              <div>
                <span className="eyebrow">PHASE TIME</span>
                <strong className="mono">
                  {remaining === null
                    ? "—"
                    : `${Math.floor(remaining / 60)
                        .toString()
                        .padStart(
                          2,
                          "0",
                        )}:${(remaining % 60).toString().padStart(2, "0")}`}
                </strong>
              </div>
              <div>
                <span className="eyebrow">YOUR ROLE</span>
                <strong>
                  {session?.kind === "host"
                    ? "Host"
                    : (me.data?.role?.replaceAll("_", " ") ?? "Spectator")}
                </strong>
              </div>
            </div>
            {!session && (
              <form className="room-join" onSubmit={join}>
                <h2>Take your place.</h2>
                <p>
                  Use the room code from your host. Your role is assigned
                  privately when the round starts.
                </p>
                <div className="workspace-controls">
                  <label>
                    Display alias
                    <input name="alias" required maxLength={24} />
                  </label>
                  <label>
                    Join code
                    <input
                      name="joinCode"
                      required
                      minLength={4}
                      maxLength={12}
                      defaultValue={
                        new URLSearchParams(window.location.search).get(
                          "code",
                        ) ?? ""
                      }
                    />
                  </label>
                  <Button type="submit" disabled={busy}>
                    Join round <Arrow />
                  </Button>
                </div>
              </form>
            )}
            {session?.kind === "host" && (
              <div className="host-panel">
                <div>
                  <span className="eyebrow">INVITE YOUR PLAYERS</span>
                  <h2>Scan. Join. Take a side.</h2>
                  <p>
                    Share the invitation with your players. Keep this host
                    session private.
                  </p>
                  <a
                    className="text-link"
                    href={joinUrl}
                    data-barba-prevent
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open player invitation <Arrow diagonal />
                  </a>
                  <div className="hero-actions">
                    <Button
                      disabled={busy || room.data?.phase !== "LOBBY"}
                      onClick={() => void hostAction("start")}
                    >
                      Start round <Arrow />
                    </Button>
                    <Button
                      disabled={
                        busy ||
                        !room.data ||
                        room.data.phase === "LOBBY" ||
                        room.data.phase === "REVEAL"
                      }
                      onClick={() => void hostAction("reveal")}
                    >
                      Reveal outcome
                    </Button>
                  </div>
                </div>
                {qr && (
                  <img
                    src={qr}
                    width={180}
                    height={180}
                    alt="QR code for this room's player invitation"
                  />
                )}
              </div>
            )}
            <div className="arena-workspace">
              <section className="arena-graph">
                <div className="panel-toolbar">
                  <span className="mono">LIVE WORKFLOW</span>
                  <span className="mono">{connection}</span>
                </div>
                <div className="graph-surface">
                  <RunGraph snapshot={snapshot.data} />
                </div>
              </section>
              <aside className="players-panel">
                <span className="eyebrow">IN THE ROOM</span>
                {room.data?.presence.players.length ? (
                  room.data.presence.players.map((p) => (
                    <div className="player-row" key={p.playerId}>
                      <span
                        className={
                          p.connected ? "status-dot live" : "status-dot"
                        }
                      />
                      <strong>{p.displayAlias}</strong>
                      <span className="mono">
                        {p.connected ? "ONLINE" : "OFFLINE"}
                      </span>
                    </div>
                  ))
                ) : (
                  <p>Waiting for players to join.</p>
                )}
              </aside>
            </div>
            {me.data && (
              <section className="cards-section">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">PRIVATE ACTIONS</span>
                    <h2>Your move.</h2>
                  </div>
                  <p>
                    Actions are authorized by the server against your role and
                    the current round phase.
                  </p>
                </div>
                {result && (
                  <div className="action-result" role="status">
                    <strong>{result.outcome}</strong>
                    <p>{result.message}</p>
                    {result.data !== undefined && (
                      <pre>{JSON.stringify(result.data, null, 2)}</pre>
                    )}
                  </div>
                )}
                <div className="action-cards">
                  {me.data.cards.map((card) => (
                    <ActionCard
                      key={card}
                      card={card}
                      used={me.data!.usedCards.includes(card)}
                      roomId={roomId}
                      session={session!}
                      state={snapshot.data}
                      evidence={me.data!.evidence}
                      options={options.data ?? []}
                      onResult={setResult}
                    />
                  ))}
                </div>
                {me.data.evidence.length > 0 && (
                  <div className="evidence-panel">
                    <h3>Your evidence</h3>
                    {me.data.evidence.map((e) => (
                      <article key={e.id}>
                        <span className="mono">{e.kind}</span>
                        <p>{e.summary}</p>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
            {reveal && (
              <section className="reveal-panel">
                <span className="eyebrow">ROUND REVEAL / RECORDED OUTCOME</span>
                <h2>
                  {reveal.score.winner === "NONE"
                    ? "No winner recorded."
                    : `${reveal.score.winner === "ATTACKER" ? "Attacker" : "Defenders"} win.`}
                </h2>
                <p>Attacker: {reveal.attackerAlias ?? "Not assigned"}</p>
                <div className="metric-row">
                  <div className="metric">
                    <span className="mono">DENIED CALLS</span>
                    <strong>{reveal.score.deniedToolCalls}</strong>
                  </div>
                  <div className="metric">
                    <span className="mono">UNSAFE ACTIONS EXECUTED</span>
                    <strong>
                      {reveal.score.unsafeActionsExecuted ?? "Not audited"}
                    </strong>
                  </div>
                  <div className="metric">
                    <span className="mono">LEGITIMATE TASK</span>
                    <strong>
                      {reveal.score.legitimateTaskCompleted
                        ? "Completed"
                        : "Incomplete"}
                    </strong>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
        <div className="arena-footer mono">
          ISOLATED ENVIRONMENT / RECORDED DECISIONS / HUMAN APPROVED RECOVERY
        </div>
      </main>
    </>
  );
}
import type { RunSnapshot } from "@bastion/contracts";
function ActionCard({
  card,
  used,
  roomId,
  session,
  state: s,
  evidence,
  options,
  onResult,
}: {
  card: string;
  used: boolean;
  roomId: string;
  session: RoomSession;
  state?: RunSnapshot;
  evidence: PlayerPrivateState["evidence"];
  options: { id: string; card: string; label: string }[];
  onResult: (r: ActionResult) => void;
}) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attack = ["POISON_DOCUMENT", "REDIRECT_TOOL", "LEAK_SECRET"].includes(
    card,
  );
  const choices = attack
    ? options
        .filter((o) => o.card === card)
        .map((o) => ({ id: o.id, label: o.label }))
    : card === "SHARE_EVIDENCE"
      ? evidence.map((e) => ({ id: e.id, label: e.summary }))
      : card === "REVIEW_TOOL_DECISION"
        ? Object.values(s?.toolRequests ?? {}).map((t) => ({
            id: t.id,
            label: `${t.toolName} / ${t.decision ?? "Pending"}`,
          }))
        : card === "QUARANTINE"
          ? Object.values(s?.incidents ?? {}).map((i) => ({
              id: i.id,
              label: i.reason,
            }))
          : card === "APPROVE_RECOVERY"
            ? Object.values(s?.approvals ?? {})
                .filter((a) => a.status === "PENDING")
                .map((a) => ({ id: a.id, label: `Recovery / ${a.incidentId}` }))
            : Object.values(s?.sources ?? {}).map((src) => ({
                id: src.id,
                label: src.name,
              }));
  async function play() {
    setBusy(true);
    setError(null);
    try {
      let body: Record<string, unknown> = { commandId: newId("command"), card };
      if (attack) body.attackPayloadId = target;
      else if (card === "INSPECT_SOURCE") body.sourceVersionId = target;
      else if (card === "TRACE_DEPENDENCY") body.fromId = target;
      else if (card === "REVIEW_TOOL_DECISION") body.toolRequestId = target;
      else if (card === "SHARE_EVIDENCE") body.evidenceId = target;
      else if (card === "QUARANTINE") {
        const incident = s?.incidents[target];
        if (!incident) throw new Error("Select an incident.");
        body = {
          ...body,
          incidentId: incident.id,
          sourceVersionId: incident.sourceVersionId,
        };
      } else if (card === "APPROVE_RECOVERY") {
        const approval = s?.approvals[target];
        if (!approval) throw new Error("Select a pending approval.");
        body = {
          ...body,
          incidentId: approval.incidentId,
          approvalId: approval.id,
          planId: approval.planId,
          actionDigest: approval.actionDigest,
        };
      }
      onResult(
        await api<ActionResult>(
          `/api/arena/rooms/${roomId}/actions`,
          session.token,
          body,
        ),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const approval =
    card === "APPROVE_RECOVERY" ? s?.approvals[target] : undefined;
  const plan = approval ? s?.plans[approval.planId] : undefined;
  return (
    <article className="action-card">
      <span className="eyebrow">
        {used ? "PLAYED" : attack ? "ATTACK" : "DEFEND"}
      </span>
      <h3>{card.toLowerCase().replaceAll("_", " ")}</h3>
      <label>
        Target
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={used}
        >
          <option value="">Select target</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {plan && (
        <div className="plan-preview">
          <p>
            Rerun:{" "}
            {plan.rerunTaskIds
              .map((id) => s?.tasks[id]?.title ?? id)
              .join(", ") || "None"}
          </p>
          <p>
            Preserve:{" "}
            {plan.preservedTaskIds
              .map((id) => s?.tasks[id]?.title ?? id)
              .join(", ") || "None"}
          </p>
          <p>
            Replacement:{" "}
            {s?.sources[plan.replacementSourceVersionId]?.name ??
              plan.replacementSourceVersionId}
          </p>
          <code>{plan.planDigest}</code>
        </div>
      )}
      <Button
        disabled={
          busy || used || !target || (card === "APPROVE_RECOVERY" && !plan)
        }
        onClick={() => void play()}
      >
        {used
          ? "Card played"
          : busy
            ? "Sending…"
            : card === "APPROVE_RECOVERY"
              ? "Approve exact plan"
              : "Play card"}{" "}
        <Arrow />
      </Button>
      <ErrorBox error={error} />
    </article>
  );
}
