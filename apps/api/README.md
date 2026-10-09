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
| `GET /api/runs/:id/tool-approvals` | — | `ToolApprovalView[]` (redacted) |
| `GET /api/tool-approvals/:id` | operator (project owner) | exact target, arguments, digest, rule, inputs |
| `POST /api/tool-approvals/:id/resolve` | operator, `ApproveToolCmd` | `{ status: "CONSUMED", outcome }` or `{ status: "REJECTED" }` |
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

## Tool approvals (`REQUIRE_APPROVAL`)

When a policy rule returns `REQUIRE_APPROVAL`, the agent's tool call **waits** while a `tool.approval_requested` event (with `tapr_` ID and redacted `resourcePreview`) goes out on the run stream.
- **Review:** the project-owning operator opens `GET /api/tool-approvals/:id` to see the exact target, then resolves it with the shown `actionDigest`.
- **Approve:** consumes the approval atomically (single use) and executes the call exactly once under the execution fence, after re-checking target, inputs, policy and workflow version. The agent receives the real result.
- **Reject, expiry (`TOOL_APPROVAL_TTL_SECONDS`), or cancellation** (the execution stops, or an input becomes unusable): the call is never executed and the agent gets a denial.
- **Restart:** every pending approval expires.

Each transition emits `tool.approval_resolved`. Arena players never see or resolve tool approvals beyond the redacted preview on the run stream.

## Restarts

On boot, work that was in flight is closed out truthfully: running executions become `FAILED`, runs become `FAILED`, and in-progress recoveries become `RECOVERY_FAILED`, all with the reason `controller restarted`. Runs with unresolved incidents are re-adopted by the scheduler, so they can still be quarantined and recovered, and a failed recovery can be re-planned.

## Workflow CLI

`pnpm workflow:validate <file>`, `pnpm workflow:project <name>`, `pnpm workflow:submit <file> --project <id>` or `--version-of <wf_id>`. Uses `API_URL` and `OPERATOR_TOKEN` from `.env`.

Score `unsafeActionsExecuted` is `null` until the sandbox target audit is wired. It is never assumed to be 0.

## Model connections

Bastion uses Pi's provider adapters for Codex, Claude and OpenRouter. Changing the provider does not change the security boundary: built-in agent tools are disabled, and file, network and process actions go through Bastion's tool gateway. Only one configured provider is active per API process. This connects the models through Pi; it does not launch the standalone Codex or Claude Code CLI.

Put the chosen configuration in the root `.env`. Commands load that file; existing shell variables take precedence, including Fish exports. `pnpm agent:models` lists model IDs and endpoints from the installed provider registry without making an inference request. Set `PI_MODEL` to one of those IDs.

For **Codex with ChatGPT sign-in**, set:

```dotenv
PI_PROVIDER=openai-codex
PI_AUTH_MODE=oauth
PI_BASE_URL=https://chatgpt.com/backend-api
PI_AUTH_FILE=/absolute/private/path/auth.json
```

Run `pnpm agent:models`, choose `PI_MODEL`, then run `pnpm agent:login` in an interactive terminal and open the displayed sign-in URL. Pi stores and refreshes credentials at the explicit `PI_AUTH_FILE` path. `PI_API_KEY` is not needed in this mode. Use a private path outside the repository, or under the ignored `.data/` directory; do not commit the credentials. This requires eligible ChatGPT Codex access and remains subject to account usage limits; it does not grant API credits. The OAuth endpoint must match the installed Codex provider to prevent forwarding subscription credentials elsewhere.

For **Claude API**, set `PI_PROVIDER=anthropic`, `PI_AUTH_MODE=api-key`, `PI_BASE_URL=https://api.anthropic.com` and `PI_API_KEY` to your Anthropic API key. Choose `PI_MODEL` with `pnpm agent:models`. Claude subscription login is not implemented; API billing is separate.

For **OpenRouter**, set `PI_PROVIDER=openrouter`, `PI_AUTH_MODE=api-key`, `PI_BASE_URL=https://openrouter.ai/api/v1` and your OpenRouter key in `PI_API_KEY`. `openrouter/free` is available in the installed registry; availability and rate limits are controlled by OpenRouter.

All providers also require explicit `PI_AGENT_DIR`, positive `PI_TIMEOUT_MS`, and the sandbox/scheduler settings in `.env.example` when `AGENT_RUNTIME=enabled`. `PI_AGENT_DIR` is Pi's local working configuration directory, while `PI_AUTH_FILE` is the OAuth credential file. Never use a `VITE_` variable for model credentials.

Run `pnpm config:check` before starting services, or `pnpm config:check --runtime` to check agent requirements even when the runtime is disabled. It reports missing/invalid configuration by field name without printing secrets. It validates the configured model and local OAuth credential structure, but does not contact databases, refresh OAuth tokens, or test model access. Restart the API after changing provider configuration.

## Wiring the runtime (Member 2)

`src/index.ts` has a single `runtime` slot: `launcher`, `scheduler`, `verifier`, `audit`, typed by the ports in `@bastion/contracts`. It is filled by `src/runtime/` (Member 2 packages composed with the journal/broker) when `AGENT_RUNTIME=enabled`.

### Automatic task planning

When the real agent runtime is enabled, `POST /api/projects/:id/task-plan` accepts `commandId` and `instruction`, with optional paired `baseWorkflowId` / `baseWorkflowVersion`. The operator must own the project and any selected workflow; cross-project reuse is rejected. The endpoint returns a validated `definition` without creating or running it. Submit that result through `POST /api/workflows`, then start a protected run normally. `/health` exposes `taskPlanningConnected`. Existing required Pi configuration supplies the planner model; there is no fallback provider.

The planner has no tools. Fresh plans without a project repository are constrained to model-generated tasks/roles with no capabilities, policy rules, or sources. A connected repository adds only its persisted, operator-selected file boundary. An explicitly selected saved workflow is adapted by changing its task instructions only; its complete execution and security structure stays pinned. Project repository connections can supply file sources and access once per project; arbitrary host paths, network access, process execution, and new file creation are not granted by that connection. Model-produced permission fields, unknown dependencies, cycles, duplicate task keys/outputs, and incomplete adaptations are rejected. Concurrent command reuse is scoped to its actor and route even before the result is persisted.

### Deployment validation

`BASTION_DEPLOYED_RUNTIME_TEST=enabled BASTION_DEPLOYED_REPORT=<private absolute path> pnpm exec vitest run tests/deployed-runtime.test.ts` checks the configured running controller, saves a generated test project/workflow through the API, runs the real model, verifies the stored result, and waits for Neo4j to project the completed events. It leaves that test project as persisted evidence. Required service locations, credentials, model timeout and blob storage come from `.env`; no alternate service is silently substituted. Provider quota/authentication failures stop planning before a run is started.

The optional `BASTION_PROVIDER_DIAGNOSTIC=enabled pnpm exec vitest run packages/runtime-pi/src/provider-connectivity.test.ts` makes one real no-tool provider request and reports a credential-redacted error when it fails. Normal tests skip both live checks. The runtime exposes only safe failure categories publicly; provider usage limits are distinguished from invalid model plans.


### Project repository access and follow-ups

`GET /api/connection` reports the configured provider/model and repository connector availability to authenticated operators. It never checks provider credits or makes a model request.

`GET/POST /api/projects/:id/repository` reads or replaces an owner-scoped, persisted project connection. POST accepts `{ commandId, selection: { directory, permissions: [{ operation, decision }] } }`; `selection: null` disconnects. Operations are registered `fs.read`/`fs.write`; explicit `fs.read: ALLOW` is required to connect source contents, and writes must use `REQUIRE_APPROVAL`. The connector requires `REPOSITORY_GIT_EXECUTABLE` (absolute installed Git path), the existing sandbox roots, timeout, tool registry, and byte budget. Git only enumerates tracked regular files; symlinks and submodules are excluded, inherited Git overrides and fsmonitor/hooks are disabled, and repository/file paths cannot escape the sandbox. The total source size must fit `SANDBOX_MAX_BYTES`. No clone, checkout, hooks, network request, or model call occurs during connection.

The compiled access contains exact file paths derived from that selection, with repository text marked UNTRUSTED/INTERNAL. Fresh plans inherit those sources and permissions and are still submitted through `POST /api/workflows` before running. Saved workflow adaptations retain their own boundary. Disconnecting affects new plans, not existing versioned workflows/runs. Reconnect to refresh the tracked-file list. Connecting does not grant shell access or access to new files. The repository must already be mounted in the configured sandbox.

Task planning also accepts `contextRunId` for a completed/recovered run in the same project. It loads that run's exact workflow version and only redacted output previews from current, clear executions, after requiring passing recorded verification. Failed, active, invalidated, cross-project and cross-owner contexts are rejected. The planner treats previews as untrusted context; the follow-up becomes a new workflow/run via the normal save/start flow, not an append to the old run or a new cross-run provenance edge.

### Executable acceptance checks

Workflow-declared TOOL checks now execute through the same policy/approval gateway while their VERIFIER execution is active, after the model finishes and before output publication. Sandbox command failure, denied access, missing evidence or a controller failure prevents task success. Each controller-issued receipt is bound to the complete check and execution; final/recovery verification checks it against the recorded exact-argument hash and successful tool request. Earlier attempts and ordinary model tool calls cannot substitute for that receipt. No new shared contract fields are needed. This verifies execution of the declared check, not universal factual accuracy.
