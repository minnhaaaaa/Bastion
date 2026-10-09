# Bastion — Team Plan

Three people, one shared contract. Read this, then `packages/contracts/src/` — that folder **is** the spec.

## Rule #1 — Zero hardcoded data

**Nothing is hardcoded. Everything is real-time.**

| Not allowed in app/package code | Instead |
|---|---|
| Canned/mock events, mock streams, fixture JSON, "sample" runs | Events produced by the real orchestrator, persisted in the journal, streamed over Socket.IO |
| Hardcoded agents, tasks, DAGs, sources, capabilities, policy rules, attack payloads | A `WorkflowDefinition` submitted via `POST /api/workflows`, validated by Zod, stored in Postgres (`workflows` table), loaded at run time |
| Default hosts, ports, credentials, URLs (`?? "localhost…"`) | Required env vars, validated at startup (`apps/api/src/env.ts`, `apps/web/src/env.ts`); missing config = startup error |
| Placeholder numbers/labels in the UI ("12/12 passed", fake counts) | Values derived from `RunSnapshot` / API responses; empty and loading states when there is no data yet |
| Hardcoded IDs | `newId()` at runtime; task/agent IDs come from the workflow definition |

**Allowed:** schemas, enums and type definitions (the contract itself); test doubles and generated test data **inside automated tests only** (`*.test.ts`, `tests/`).
**Demo:** to be decided later. Whatever we choose will be loaded as workflow data through the API, not committed as code.

Reviewers: reject any PR that ships data in non-test code.

## Step 0 (done): shared foundation

| What | Where |
|---|---|
| Monorepo (pnpm + Turborepo), all packages stubbed | `apps/*`, `packages/*` |
| IDs (prefixed: `run_`, `wf_`, `task_`, `exec_`, `agent_`, `src_`, `art_`, `tool_`, `inc_`, `appr_`, `plan_`, `room_`, `player_`, `cmd_`, `trace_`, `evt_`) + `newId()` | `contracts/src/ids.ts` |
| All enums (task/security/run states, decisions, arena phases/roles/cards, graph labels/rels) | `contracts/src/enums.ts` |
| Entity schemas (1:1 with DB tables) | `contracts/src/entities.ts` |
| **`WorkflowDefinition`** — agents, sources, tasks, policy rules, attack payloads as data, with validation (unknown refs, cycles) | `contracts/src/workflow.ts` |
| **Run event union** (29 types) + envelope | `contracts/src/events.ts` |
| REST command bodies (every mutation has `commandId`) | `contracts/src/commands.ts` |
| Socket.IO server↔client contract | `contracts/src/socket.ts` |
| `RunSnapshot`, `GraphView` | `contracts/src/snapshot.ts` |
| **Pure reducer** `applyEvent` / `replay` / `toGraphView` (used by API *and* UI) | `contracts/src/reduce.ts` |
| **Ports** — interfaces where our modules meet | `contracts/src/ports.ts` |
| Postgres schema (18 tables incl. `workflows`, enums sourced from contracts) + migration | `packages/db/src/schema.ts`, `packages/db/migrations/` |
| Neo4j constraints + edge-direction convention | `packages/knowledge-graph/schema.cypher` |
| Env-only config (no defaults) | `.env.example`, `apps/api/src/env.ts`, `apps/web/src/env.ts`, `docker-compose.yml` |

### Conventions everyone must follow

- **Edges point downstream (data-flow).** `(src|art)-[:CONSUMED]->(exec)`, `(exec)-[:PRODUCED]->(art)`, `(src|art)-[:DERIVED_FROM]->(art)`. Impact set = forward traversal. Full list at top of `reduce.ts`.
- **Task IDs come from the workflow definition** and are unique per run; DB key is `(run_id, id)`. Everything else gets `newId()`.
- **Runs pin a workflow version** (`workflowId` + `workflowVersion`) so a run is reproducible after the definition changes.
- **Persist before broadcast.** Only the `EventJournal` assigns `eventId`/`seq`/`timestamp`; producers append `NewRunEvent`s.
- **Sockets are read-only.** All mutations are REST + Zod + role check + `commandId` dedup.
- **No raw content in events** — `preview` (≤280 chars, redacted) + `blobRef` only. No attacker identity in run events.
- **SUCCEEDED ≠ trusted.** Execution state and security state are separate fields.
- Intentional deviations from ARCHITECTURE.md: added `run.planned`, `source.security_state_changed`, `artifact.trust_changed`; one `tool.decided` event instead of separate allowed/denied events; added `workflows`, `source_versions`, `recovery_plans`, `command_results` tables; runs reference `workflowId` instead of `scenarioId`.

### Contract-change rule
`packages/contracts` is frozen. Changes = small PR, all three ack. **Add fields, don't rename.** Keep `pnpm test` green.

---

## How the UI stays unblocked without mock data

Member 1 builds against the **real API from day one**:
1. Member 3 ships the thin live path first (M1 early): `POST /api/workflows`, `POST /api/runs`, `GET /api/runs/:id`, `run.subscribe` → `run.snapshot` / `run.event`.
2. Member 2 ships the scheduler with the runtime adapter early, so a submitted workflow produces real `task.*` / `artifact.*` / `tool.*` events.
3. Until then, Member 1 builds layouts with proper **empty, loading and error states**, which every screen needs anyway. Never fill a screen with invented values.

---

## Member 1 — UI (`apps/web`)

- [ ] `features/stream/useRunStream(runId)`: socket `run.subscribe` → `run.snapshot` / `run.event`, fold with `applyEvent`; on `SeqGapError` resubscribe; reconnect with `lastSeq`.
- [ ] `features/api/`: typed REST client from `contracts/commands.ts` (generates `commandId` via `newId("command")`).
- [ ] `/` landing: hero, Try Arena / Launch Console; graph preview shows a **live** run if one exists, otherwise an empty state.
- [ ] `/dashboard`: runs + workflows from the API; "new run" from a registered workflow.
- [ ] `/runs/:runId`: React Flow from `toGraphView` (dagre/elk layout), colour by `taskState` + `securityState`, rerun attempts visible; live event timeline.
- [ ] `/incidents/:id`: source inspector (preview), impact subgraph, plan diff (rerun vs preserved), Approve → `ApproveRecoveryCmd`.
- [ ] `/policies`: policy rules of the selected workflow (read-only, from API).
- [ ] `/arena/:roomId/host`: QR (`qrcode`) of the live join URL, presence, phase timer from server clock, live graph, reveal + score from `arena.reveal`.
- [ ] `/arena/:roomId`: mobile player — role and cards from `player.private_state`; attack cards list the workflow's `attackPayloads` from the API; typed `ArenaActionCmd`, no free text.
- [ ] P1: Motion transitions, baseline vs protected side-by-side. Playwright: join flow, approval flow.

## Member 2 — Agent runtime, security, sandbox

Owns: `runtime-adapter`, `runtime-pi`, `security`, `orchestrator`, `scenario-kit`, `sandbox/`.

- [x] **Pi spike first (M0):** confirm real `@mariozechner/pi-coding-agent` API; prove file/http/exec tools can be replaced or wrapped so every call hits `ToolGateway.dispatch`. Report back early if not.
- [x] `security`: `PolicyEngine` evaluating the **workflow's** `policyRules` + agent capabilities (glob match, rule IDs, `default.deny`); `ToolGateway` (normalize → `tool.requested` → evaluate → `tool.decided` → re-check inputs `isUsable` right before execution → `tool.executed`; any error = deny + `policy.unavailable`). Unit tests with generated rules.
- [ ] `sandbox/`: Docker worker, deny-by-default egress; hosts/paths come from config; target services record a **real access audit log** (acceptance #1).
- [x] `orchestrator`: `Scheduler` builds `TaskSpec`s from the run's workflow definition; ready when deps' artifacts are usable; bounded parallelism; `hold`; `rerun` with fresh executionIds/attempt+1; emits `run.planned`, `task.state_changed`, `agent.session_*`.
- [x] `runtime-adapter`: interface + test-only fake (lives in test files).
- [x] `scenario-kit`: workflow runner — loads sources from their `location`, applies attack payloads by `attackPayloadId`, baseline/protected modes, verifier checks. Contains no workflow data.

Implementation and integration instructions: `sandbox/README.md`. The Docker worker and compose configuration are implemented; a real host-worker test verifies zero audited reads for a protected denial and an actual baseline read. Container egress checks remain pending because the Docker daemon was unavailable during implementation. A provider-driven run requires configured credentials and Member 3's real journal/broker. Tool approval policies stay blocked until an authorized tool-approval service exists; the frozen contracts were not changed.

## Member 3 — Data, provenance, recovery, API ✅ implemented

Owns: `db`, `provenance`, `knowledge-graph`, `recovery`, `apps/api`. API reference: [`apps/api/README.md`](apps/api/README.md).

- [x] **Thin live path** (unblocks Member 1): `EventJournal`, `WorkflowRepository`, `POST /api/workflows`, `POST/GET /api/runs`, `GET /api/runs/:id/events`, socket `run.subscribe`.
- [x] `db`: `PgEventJournal` (per-run lock + `UNIQUE(run_id, seq)`, events and relational rows in one transaction, listeners after commit in commit order) + repositories + PGlite test harness (`@bastion/db/testing`).
- [x] `provenance`: `PgArtifactBroker` (sha256 content-addressed blobs in `BLOB_DIR`, versions, observed CONSUMED/PRODUCED/DERIVED_FROM edges, `consume` refuses unusable versions, redacted previews).
- [x] `knowledge-graph`: `Neo4jProjector` (idempotent MERGEs, per-run cursor, replay from journal, emits `graph.projected`); `impactSet` Cypher. Live test runs when `NEO4J_TEST_URI` is set.
- [x] `recovery`: `RecoveryManager` — auto-incident on DENY traced to untrusted upstream sources; synchronous quarantine → `Scheduler.hold` → invalidate → `containment.applied`; topological plan + preserved set + sha256 digest; single-use, expiring, digest-bound, human-only approvals; `approveAndRecover` → `Scheduler.rerun` → `RecoveryVerifier` → `recovery.completed` (fails closed).
- [x] `apps/api`: all REST from ARCHITECTURE §8 + workflows/projects, bearer auth (operator/host/player), `commandId` idempotency, Socket.IO with gap-free sync + `lastSeq` replay, arena rooms (hashed join codes/tokens, 2–6 role allocation, server-clock phases, unicast private state, reveal gating).
- [ ] Needs Member 2 to plug real `RunLauncher` / `Scheduler` / `RecoveryVerifier` / `TargetAudit` into `apps/api/src/index.ts` (`runtime` slot). Until then `/health.runtimeConnected=false` and runs/rooms return 503.
- [ ] Verify against real Postgres + Neo4j via `docker compose` (tests use in-process PGlite).

---

## Milestones

| # | Goal (gate) | M1 UI | M2 runtime/security | M3 data/API |
|---|---|---|---|---|
| **M0** | Step 0 merged, everyone `pnpm test` green, `.env` filled | App shell + API health live | Pi spike | compose up + `pnpm db:migrate` |
| **M1** | A registered workflow runs live; a real Pi tool call is **denied before execution** | Run graph + timeline on live stream | Policy, gateway, sandbox, scheduler | Thin live path, journal, broker |
| **M2** | Quarantine → only affected tasks rerun; independent branch untouched | Incident page + approve | `hold` / `rerun`, verifier | Projector, planner, approvals |
| **M3** | Arena on live rooms | Host/player/QR | Attack payload application, baseline runner | Rooms/roles/phases/reveal |
| **M4** | Demo (content decided later, loaded as data) + rehearsal | Polish | Fix | Fix |

Priority rule (ARCHITECTURE §15): a real end-to-end security event beats UI polish.

## Done = ARCHITECTURE §14 acceptance tests pass
Key ones: #1 deny-before-side-effect (target audit = 0), #4/#5 quarantine closure with the independent branch's attempt unchanged, #6 role privacy, #7 replay == live (already covered for the reducer in `contracts.test.ts`).
