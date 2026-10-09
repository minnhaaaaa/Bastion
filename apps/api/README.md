# Bastion API

Fastify + Socket.IO control plane. Every response is derived from persisted events. There is no mock mode.

## Auth

`Authorization: Bearer <token>`. There are three kinds of token:

| Token | Issued by | Can |
|---|---|---|
| Operator | `OPERATOR_TOKENS` env | Projects, workflows, runs, incidents (own projects only); create arena rooms |
| Host | `POST /api/arena/rooms` response (`hostToken`) | Start/reveal that room; projector socket |
| Player | `POST /api/arena/rooms/:id/join` response (`playerToken`) | Own private state, card actions in that room |

Errors always have the shape `{ error: { code, message } }` (`ApiError` in contracts). If the agent runtime isn't connected, routes that need it return `503`. Check `/health` → `runtimeConnected`.

Every mutation body carries `commandId` (`newId("command")`). Replaying the same command returns the stored result, with the `idempotent-replay: true` header.

## REST

| Method & path | Body (contracts) | Returns |
|---|---|---|
| `GET /health` | — | `{ ok, startedAt, now, runtimeConnected, graphConnected }` |
| `POST /api/projects` | `CreateProjectCmd` | `Project` |
| `GET /api/projects` | — | `Project[]` |
| `POST /api/workflows` | `CreateWorkflowCmd` | `Workflow` (v1) |
| `POST /api/workflows/:id/versions` | `CreateWorkflowVersionCmd` | `Workflow` (next version) |
| `GET /api/workflows?projectId=` | — | latest `Workflow[]` |
| `GET /api/workflows/:id[?version=]` | — | `Workflow` |
| `POST /api/runs` | `CreateRunCmd` | `{ runId }` (503 without runtime) |
| `GET /api/runs[?projectId=]` | — | `RunSummary[]` |
| `GET /api/runs/:id` | — | `RunSnapshot` |
| `GET /api/runs/:id/events?after=&limit=` | — | `RunEvent[]` |
| `GET /api/runs/:id/graph` | — | `GraphView` + `lastSeq`, `graphProjectedUpTo` |
| `GET /api/runs/:id/incidents` | — | `SecurityIncident[]` |
| `GET /api/runs/:id/impact?fromId=` | — | `{ authoritative, graph }` impact sets |
| `GET /api/runs/:id/metrics` | — | `RunMetrics` (from events + target audit) |
| `GET /api/compare?protected=&baseline=` | operator | `RunComparison` |
| `GET /api/runs/:id/export` | operator | `{ run, workflow, runtime, metrics, events }` (JSON download) |
| `POST /api/runs/:id/incidents` | `OpenIncidentCmd` | `SecurityIncident` |
| `POST /api/incidents/:id/quarantine` | `QuarantineCmd` | `{ ok, suggestedReplacementSourceVersionId }` |
| `POST /api/incidents/:id/recovery-plan` | `RecoveryPlanCmd` | `RecoveryPlan` (+ `approval.requested` event) |
| `POST /api/incidents/:id/approve-recovery` | `ApproveRecoveryCmd` | `{ ok, decision }` (202) |
| `POST /api/arena/rooms` | `CreateRoomCmd` | `CreateRoomResult` `{ roomId, joinCode, hostToken }` |
| `GET /api/arena/rooms/:id` | — | public phase + presence (no roles) |
| `POST /api/arena/rooms/:id/join` | `JoinRoomCmd` | `JoinRoomResult` |
| `GET /api/arena/rooms/:id/me` | player | `PlayerPrivateState` |
| `GET /api/arena/rooms/:id/attack-options` | attacker | `{ id, card, label, targetSourceName }[]` |
| `POST /api/arena/rooms/:id/start` | host, `StartRoundCmd` | `ArenaPhaseUpdate` |
| `POST /api/arena/rooms/:id/{pause,resume,reset}` | host, `Pause/Resume/ResetRoundCmd` | `ArenaPhaseUpdate` (`paused`, `round`) |
| `POST /api/arena/rooms/:id/actions` | player, `ArenaActionCmd` | `ActionResult` |
| `POST /api/arena/rooms/:id/reveal` | host, `RevealCmd` | `ArenaReveal` |

The approval to approve is the `approval.requested` event (or `snapshot.approvals`). Send back its `approvalId`, together with the plan's `planId` and `planDigest`.

## Socket.IO

Connect with `io(API_URL, { auth: { token } })`. Unauthenticated sockets are rejected. The socket only pushes updates; all changes go through REST.

- `run.subscribe { runId, lastSeq? }`: without `lastSeq`, the server sends `run.snapshot`; with it, the server replays the missing `run.event`s. After that, live `run.event`s arrive in `seq` order with no gaps. Fold them with `applyEvent`; on `SeqGapError`, resubscribe without `lastSeq`.
- `room.subscribe { roomId }` (host or player token): `arena.phase`, `room.presence`, and for players a unicast `player.private_state` / `action.result`. `arena.reveal` arrives after the host reveals.

## Arena round

`LOBBY` → host start (2–6 players; roles assigned privately) → `BRIEFING` (timed) → `ATTACK_WINDOW` (timed; attacker queues payloads) → `AGENT_EXECUTION` (a real run starts with the queued attacks) → `INVESTIGATION` (first incident) → `CONTAINMENT` (quarantine) → `RECOVERY` (approved rerun) → host reveal → `REVEAL`.

Host **pause** freezes the round clock and rejects player actions; the agents keep running. **Reset** returns to `LOBBY` with the same players and a new `round`. Earlier runs stay in history. If a defender holding `QUARANTINE`/`APPROVE_RECOVERY` stays offline past `ARENA_RECONNECT_GRACE_SECONDS`, the card moves to a connected defender. Expired rooms are swept: their tokens stop working and their sockets are closed. Joins and actions are rate-limited (`429 RATE_LIMITED`).

## Restarts

On boot, work that was in flight is closed out truthfully: running executions become `FAILED`, runs become `FAILED`, and in-progress recoveries become `RECOVERY_FAILED`, all with the reason `controller restarted`. Runs with unresolved incidents are re-adopted by the scheduler, so they can still be quarantined and recovered, and a failed recovery can be re-planned.

## Workflow CLI

`pnpm workflow:validate <file>`, `pnpm workflow:project <name>`, `pnpm workflow:submit <file> --project <id>` or `--version-of <wf_id>`. Uses `API_URL` and `OPERATOR_TOKEN` from `.env`.

Score `unsafeActionsExecuted` is `null` until the sandbox target audit is wired. It is never assumed to be 0.

## Wiring the runtime (Member 2)

`src/index.ts` has a single `runtime` slot: `launcher`, `scheduler`, `verifier`, `audit`, typed by the ports in `@bastion/contracts`. It is filled by `src/runtime/` (Member 2 packages composed with the journal/broker) when `AGENT_RUNTIME=enabled`.
