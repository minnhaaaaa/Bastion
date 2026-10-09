# Parallel work while Member 1 builds the UI

The backend is feature-complete and tested (60 tests), including the Member 2 runtime wiring. While Member 1 builds `apps/web`, Members 2 and 3 should make it **run for real**, **survive failure**, and **give the UI everything it needs**, without slowing Member 1 down.

Rules (unchanged): **zero hardcoded data** (TEAM_PLAN.md → Rule #1), `packages/contracts` changes are additive and acknowledged by all three, and run `pnpm test` before every push.

---

## 0. Ground rules for not blocking the UI

- **Keep the API stable.** Only add things: new fields, new endpoints, new event types. Never rename or remove. If a change touches `apps/api/README.md` or `packages/contracts`, tell Member 1 the same day.
- **Keep a running API.** From step A1 onwards, keep a shared dev API up (real Postgres, Neo4j and runtime) that Member 1 can point `VITE_API_URL` at.
- **Answer UI questions first.** If Member 1 is blocked on the API, that beats anything below.

---

## Member 3: data, recovery, API

### A1. Run it on real infrastructure *(do first: unblocks everyone)*
- [x] Install Docker. Fill `.env` from `.env.example`, then `docker compose up -d` and `pnpm db:migrate`.
- [x] Run the live Neo4j test (`NEO4J_TEST_URI`/`_USER`/`_PASSWORD`, then `pnpm test`). Check that `/api/runs/:id/impact` returns both the Postgres and the Neo4j impact sets, and that they agree.
- [x] Start the API with `AGENT_RUNTIME=disabled` (verified locally against real Postgres + Neo4j). Still to do: share a URL Member 1 can reach (LAN IP or a tunnel; set `WEB_ORIGIN` to their dev origin) and an operator token.
- **Done when:** Member 1's app talks to a live API backed by real Postgres and Neo4j.

### A2. Workflow submission tooling *(a tool, not data)*
- [x] Add `pnpm workflow:submit <file.json>`: it reads a definition from a path you pass in and POSTs it to `/api/workflows`, using `API_URL` and `OPERATOR_TOKEN` from the environment. No definitions are committed to the repo.
- [x] Add `pnpm workflow:validate <file.json>`, which validates locally with `WorkflowDefinition` and prints readable errors.
- **Done when:** anyone can register a workflow from a local file in one command.

### A3. Restart resilience
- [x] On boot, find runs whose status is `RUNNING`/`RECOVERING` but which have no live scheduler state. Mark them `FAILED` with the reason `controller restarted` (record it truthfully; never pretend they resumed).
- [x] Rebuild active-recovery tracking from events (`recovery.started` with no `recovery.completed`), or close those recoveries as `RECOVERY_FAILED` with the same reason.
- [x] Check that `ArenaService.resumeAll()` re-arms timers after a restart, and add a test for it.
- **Done when:** killing the API mid-run and restarting it leaves every run in a state that is honest and visible to the UI.

### A4. Arena hardening
- [x] Host **pause/resume/reset**: new `POST /api/arena/rooms/:id/{pause,resume,reset}`, host-only, with additive commands in contracts.
- [x] **Approver reassignment:** if the defender holding `APPROVE_RECOVERY` disconnects, give the card to another connected defender. If there is none, the host can approve through the operator console.
- [x] **Room expiry sweep:** expire rooms past `expiresAt` and disconnect their sockets.
- [x] **Rate limits** on `/join` and `/actions` (`@fastify/rate-limit`, limits from env).
- [x] Tests for each.

### A5. Evaluation and comparison (feeds the UI's side-by-side view)
- [x] `GET /api/runs/:id/metrics`: denied calls, unsafe accesses (target audit), legitimate completion, rerun count, quarantine coverage (impact vs invalidated), false blocks, durations. All derived from events and the audit.
- [x] `GET /api/compare?protected=<runId>&baseline=<runId>`: both metric sets plus a check that the two runs used the same pinned workflow version.
- [x] `GET /api/runs/:id/export`: the full event trace plus metrics as JSON, labelled with the workflow version and model config.
- **Done when:** Member 1 can render the comparison view from one endpoint.

### A6. Acceptance tests (ARCHITECTURE §14)
- [x] Map each of tests #1–#9 to an automated test, adding any that are missing. #2 (agent isolation) and #8 (a client forging approval over sockets) need explicit tests.

---

## Member 2: runtime, security, sandbox

### B1. Sandbox for real *(do first)*
- [x] Build the sandbox image and run it with `docker compose -f sandbox/compose.yml`.
- [x] **Prove egress is denied:** from inside the worker, show that a request to any origin outside `SANDBOX_HTTP_ORIGINS` fails at the network level, not only in the worker's code.
- [x] Put the target service(s) on the internal network, and show that the access audit file is written outside the agent-writable mount.
- **Done when:** the last open item in TEAM_PLAN.md (`sandbox/`) is ticked, with evidence in `sandbox/README.md`.

### B2. First real model run
- [ ] Configure a Pi provider (`PI_*`), set `AGENT_RUNTIME=enabled`, and run a submitted workflow end to end.
- [ ] Record what really happened: prompts, tool calls, denials, timing, tokens if available. Repeat several times and write down the variance, since LLM runs aren't deterministic.
- [x] Decide what to do about the **deprecated Pi package**: stay pinned at 0.73.1, or move to its successor. Write the decision in `sandbox/README.md`.
- **Done when:** a real-model protected run and a real-model baseline run both complete on the shared dev API.

### B3. Tool-call approval path (`REQUIRE_APPROVAL`)
- [x] Today, any tool call that a policy marks `REQUIRE_APPROVAL` is always denied. Design a digest-bound, single-use, expiring tool approval, mirroring recovery approvals. Agree the additive contract changes (command, events) with Member 3, who builds the API route.
- **Done when:** a human can approve one exact pending tool call, and it then executes exactly once.

### B4. Verification depth (P1)
- [x] Emit `claim.unverified`: check selected claims in outputs against the run's brokered sources, and flag the ones that aren't supported. *(Member 2's `verifySelectedClaims`, run by Member 3's `SOURCE_QUOTE` acceptance checks.)*
- [~] Let workflows declare their own acceptance checks (schema + SOURCE_QUOTE done by Member 3; TOOL checks need the scheduler to run them inside the verifier task), such as an allowed `proc.exec` test command. The verifier runs these on top of the state-based checks in `apps/api/src/runtime/verification.ts`. This needs an additive `WorkflowDefinition` field, agreed with Member 3.

### B5. Remaining attack cards (P1)
- [x] Confirm `REDIRECT_TOOL` and `LEAK_SECRET` work end to end once a workflow defines payloads for them. The runner already handles them generically, so this is about validation and tests, not new code paths.

Member 2 evidence: `sandbox/README.md` records the exact dependency decision, real target and audit tests, opt-in Docker network test, private Pi traces and repeated-model-run tooling. B5 has persisted protected/baseline end-to-end tests with a test-only scripted LLM. B1/B2 live gates remain open: Docker's engine did not start and no live environment/workflow was supplied. B3/B4 implementation helpers and tests are prepared; `sandbox/CONTRACT_PROPOSAL.md` is the concrete review item for all-three acknowledgement before shared-schema changes and Member 3's approval route/store/waiter wiring.

---

## Together (Members 2 + 3)

### C1. First workflow content *(when the demo is decided)*
- [ ] Write the workflow definition, source documents, trusted fallback and attack payload files in a **local content folder outside the code** (gitignored, or a separate private repo). Register it with `pnpm workflow:submit`.
- [ ] Rehearse a protected run and a baseline run on the shared dev API.

### C2. Multi-process readiness (only if we deploy more than one API instance)
- [ ] Replace the in-memory `ExecutionFence` and the per-run journal lock with Postgres advisory locks.

---

## Suggested order and sync points

| When | Member 2 | Member 3 | Member 1 gets |
|---|---|---|---|
| First | B1 sandbox | A1 real infra, A2 submit tool | A live API URL and token |
| Next | B2 real model run | A3 restart resilience | Real runs streaming into the run view |
| Then | B3 tool approvals | A4 arena hardening | A stable arena backend for the host and player screens |
| Then | B4/B5 | A5 metrics/compare, A6 acceptance tests | Data for the comparison view |
| Demo prep | C1 content + rehearsal | C1 content + rehearsal | The final end-to-end flow |

Daily: a 5-minute sync covering any API or contract changes, what's deployed on the shared dev API, and what's blocking the UI.
