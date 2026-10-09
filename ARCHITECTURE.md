# SPLITBRAIN — System Architecture

**Status:** Finalized MVP design baseline · **Date:** 9 October 2026  
**Frontend:** React + TypeScript + Vite  
**Backend:** Fastify + TypeScript; Pi-backed multi-agent workers

## 1. Architectural goal

Build a **security-native orchestrator** that uses existing agent harnesses for model/tool execution while controlling: task delegation, inter-agent artifact handoff, pre-tool authorization, incident containment, and task-level recovery.

**Correct security claim:** We enforce *specified policies at controlled execution boundaries* and preserve traceable *observed* dependencies. We do not guarantee full prompt-injection immunity, hallucination elimination, or analysis of opaque external agents.

## 2. System context

```text
                      ┌───────────────────────────┐
                      │ React + Vite SPA          │
                      │ Landing / Dev Console     │
                      │ Arena Host / Player       │
                      └─────────────┬─────────────┘
                                    │ HTTPS REST + Socket.IO
                      ┌─────────────▼─────────────┐
                      │ Fastify Control Plane     │
                      │ auth / rooms / commands   │
                      │ event fan-out / replay    │
                      └──────┬──────────┬─────────┘
                             │          │
            ┌────────────────▼─┐   ┌────▼───────────────┐
            │ SPLITBRAIN Core  │   │ PostgreSQL         │
            │ task scheduler   │   │ event journal      │
            │ artifact broker  │◄─►│ policies / state   │
            │ incident manager │   │ DAG / artifacts    │
            │ recovery planner │   │ rooms / votes      │
            └────────┬─────────┘   └────────────────────┘
                     │ commands/events
            ┌────────▼───────────────────┐
            │ Tool Gateway + Policy Gate │
            │ deny/allow/approval        │
            └────────┬───────────────────┘
                     │ controlled calls
         ┌───────────▼─────────────────────────┐
         │ Isolated local/demo worker sandbox  │
         │ Pi session Research / Builder / QA  │
         │ synthetic repo, docs, test services │
         └─────────────────────────────────────┘
```

**Trust separation:** Browser clients are untrusted. Agent model outputs, retrieved documents, and tools are untrusted by default. The server is the authoritative controller; sandbox and OS/network controls must enforce prohibited operations, not merely observe them.

## 3. Components and responsibilities

| Module | Owns | Does not own |
| --- | --- | --- |
| `apps/web` | Presentation, join UX, graph rendering, commands | Policy decisions, authoritative execution state |
| `apps/api` | Authentication/authorization, REST, Socket.IO, room lifecycle | LLM reasoning |
| `orchestrator` | Task DAG, scheduling, pause/resume, assignment, task states | External policy rules, tool implementation |
| `runtime-adapter` | Interface for agent sessions, tool request and event hooks | Persistent business logic |
| `runtime-pi` | Pi-backed implementation of adapter | Cross-framework compatibility guarantee |
| `security` | Capability checks, action authorization, approvals, redaction policy | Guaranteed semantic attack detection |
| `knowledge-graph` | Neo4j projection, typed entities/relations, impact and provenance queries | Authorization decisions based solely on eventually consistent graph state |
| `provenance` | Versioned artifacts, explicit edges, trust/source records | Internal LLM reasoning attribution |
| `recovery` | Descendant invalidation, rerun planning, verification | Arbitrary rollback of external side effects |
| `scenario-kit` | Synthetic attack fixtures and expected results | Production vulnerability exploitation |
| `db` | Persistent authoritative model and append-only events | Real-time UI animation |

## 4. Agent execution and orchestration

### 4.1 Interface contract

Define a runtime-neutral adapter. **Exact Pi API binding is implementation work and must be tested against its current upstream SDK.**

```ts
type AgentRunRequest = {
  runId: string;
  taskId: string;
  agentId: string;
  inputArtifactIds: string[];
  capabilities: string[];
  workspaceId: string;
};

interface AgentRuntimeAdapter {
  startTask(req: AgentRunRequest): Promise<{ sessionId: string }>;
  requestStop(sessionId: string): Promise<void>;
  subscribe(sessionId: string, sink: (event: RuntimeEvent) => void): () => void;
}
```

**Security requirement:** Pi tools that can touch files/network/subprocesses must be replaced, wrapped, or sandbox-restricted so the same **pre-execution gateway** applies. Runtime adapter event subscriptions by themselves are insufficient.

### 4.2 Task DAG

States: `PENDING → READY → RUNNING → SUCCEEDED` or `FAILED`; security states tracked separately: `CLEAR | REVIEW | QUARANTINED | INVALIDATED`. Add `PAUSED` state for unfinished tasks; never mistake `SUCCEEDED` for `TRUSTED`.

A task runs when all required **versioned input artifacts** are available, valid, and not quarantined. The scheduler permits bounded parallelism. Retries require idempotency or an explicit retry policy.

### 4.3 Brokered artifact handoff

Agents exchange declared artifacts via the broker, **not free-form privileged shared memory**. Each artifact stores a content hash, version, producer task, source IDs, classification and trust state. Consumer tasks declare consumed artifact versions. `CONSUMED_BY` edges become the basis for downstream invalidation.

In the MVP, provenance reflects actual brokered inputs and outputs. The system may conservatively treat all descendants as potentially affected; it does not infer the model's exact internal causal dependence.

## 5. Security architecture

### 5.1 Threat model

**Attacker controls:** A sandbox document body or tool-result payload through an Arena card; may try to coerce other agents through untrusted content. Attacker has no policy-admin privilege and cannot modify authoritative events.  
**Assets:** Synthetic sensitive files, sandbox request destinations, verified final output and agent capabilities.  
**Attack classes demonstrated:** Prompt injection causing attempted unauthorized tool access / synthetic exfiltration; suspicious downstream artifact reliance.  
**Out of scope:** Arbitrary container escape, third-party endpoint attacks, adversarial model weights, full inference-time jailbreak resistance.

### 5.2 Control boundaries

1. **Identity:** Each agent instance receives a server-created run-scoped ID and capability profile; identity is not taken from model-generated text.
2. **Tool gateway:** Normalize `(run, agent, tool, operation, resource, destination, input classification)` into a policy request before dispatch.
3. **Deterministic decision:** `ALLOW | DENY | REQUIRE_APPROVAL` plus machine-readable rule ID and reason. Default deny outside granted capabilities.
4. **Sandbox:** Limit network egress and filesystem/credential access independently of application checks. Simulated internal service runs in a private isolated network; no host-local metadata services exposed.
5. **Output channel:** Broker enforces artifact sharing and classification; log redaction prevents event stream exposure of synthetic secrets.
6. **Human approvals:** Tied to user, room/project role, exact action digest, expiry, and single use; a model cannot approve its own action.

### 5.3 Risk coverage

- **Prompt injection/jailbreaks:** suspicious-content alerting is heuristic; **privilege boundary** holds for mediated operations.
- **Unsafe tools/SSRF:** allowlisted target operations and deny-by-default egress within the configured sandbox.
- **Data leakage:** controlled outbound endpoints and synthetic-data classification; no broad claim for unconstrained model text.
- **Hallucinations:** bounded evidence-based checks of selected artifacts; failure emits `UNVERIFIED_CLAIM`, not guaranteed truth.
- **Auditing:** immutable-ish append-only application journal with content digests; DB admin compromise remains out of scope.

## 6. Security knowledge graph and selective recovery

### 6.1 Knowledge graph model (Neo4j)

The **knowledge graph is a first-class backend capability**, not just nodes drawn in React Flow. Neo4j stores a queryable projection of agent identity, permissions, provenance, execution and security relationships. PostgreSQL remains the authoritative event journal and transactional source of truth; an idempotent graph projector applies committed events to Neo4j.

**Node labels:** `Agent`, `TaskExecution`, `Source`, `ArtifactVersion`, `ToolCall`, `Resource`, `Policy`, `SecurityIncident`.

**Typed relationships:** `EXECUTED`, `CONSUMED`, `PRODUCED`, `DERIVED_FROM`, `REQUESTED`, `TARGETED`, `GOVERNED_BY`, `FLAGGED_IN`, `DEPENDS_ON`.

Node/edge properties include stable IDs, `runId`, source/type, timestamps, evidence reference, classification, `trustState`, and provenance event sequence. An observed `CONSUMED` edge proves that input was supplied to a task—not that it actually influenced hidden model reasoning. Querying the transitive `CONSUMED` / `PRODUCED` / `DEPENDS_ON` closure gives a conservative impact set.

**Example (illustrative Cypher):**

```cypher
MATCH (s:Source {id: $sourceId})-[:DERIVED_FROM|CONSUMED|PRODUCED|DEPENDS_ON*1..]->(affected)
RETURN DISTINCT affected
```

Adapt edge direction to the concrete graph schema when implementing; validate Cypher query results against test fixtures. Include `runId` filtering to avoid crossing unrelated sessions. For complex impact analysis, prefer explicit traversal over a vetted edge subset rather than allowing every relationship type.

**Consistency rule:** Graph projection may lag the event journal. Safety-critical containment must synchronously mark the source quarantined and block dependent dispatches in the authoritative control plane. Do not allow an unsafe operation based only on a possibly stale Neo4j result; hold affected work until the graph has processed the relevant event sequence or conservatively invalidate the broader task DAG.

Every event has `eventId`, `runId`, `seq`, `timestamp`, `traceId`, optional `taskId/agentId`, and typed `payload`. Persist event *before* broadcast. One ordered sequence per run avoids conflicting projector timelines.

### 6.2 Containment algorithm

```text
quarantine(sourceVersion):
  atomically mark sourceVersion QUARANTINED
  affected = all task descendants through observed CONSUMED edges
  prevent newly scheduled dependent tasks from starting
  cancel or hold active affected tasks at supported safe boundaries
  mark dependent output versions INVALIDATED
  emit incident + recovery candidate events
```

Concurrent in-flight operations require a safety gate at tool dispatch; a request proposed before quarantine must be re-authorized immediately before execution. Pausing is cooperative except where process/container termination is supported.

### 6.3 Recovery algorithm

```text
recover(incidentId, approvedReplacement):
  validate authorized human approval
  verify replacement input source is eligible
  topologically sort invalidated task closure
  preserve completed tasks whose consumed artifact versions are unaffected
  rerun affected idempotent tasks with fresh artifact versions
  execute verifier acceptance + security tests
  mark run RECOVERED only if validations pass
```

Recovery is **task-level**: no promise to rewind a model's individual turns. Side-effecting actions (deployment, payment, email) are prohibited in the MVP or require explicit pre-commit approval; do not auto-replay them.

## 7. Data model (PostgreSQL / Drizzle + Neo4j)

Key tables:

| Table | Key fields |
| --- | --- |
| `projects` | id, ownerId, name, policySetId |
| `agent_specs` | id, projectId, role, capabilityProfile |
| `runs` | id, projectId, scenarioId, status, startedAt, finishedAt |
| `task_specs` | id, runId, role, declaredDeps, retryPolicy |
| `task_executions` | id, taskId, attempt, state, sessionId, startedAt, finishedAt |
| `artifact_versions` | id, runId, version, contentHash, sourceId, producerExecutionId, classification, trustState, blobRef |
| `dependency_edges` | id, runId, fromType, fromId, toType, toId, relation |
| `tool_requests` | id, executionId, toolName, argsHash, decision, policyRuleId, executionOutcome |
| `security_incidents` | id, runId, sourceVersionId, severity, state, reason |
| `approval_requests` | id, incidentId, actorId, actionDigest, expiry, status |
| `events` | id, runId, seq, traceId, type, payload, createdAt |
| `arena_rooms` | id, runId, joinCodeHash, status, hostId |
| `arena_players` | id, roomId, sessionId, role, displayAlias, connected |
| `arena_actions` | id, roomId, playerId, commandId, type, outcome |

`dependency_edges` in PostgreSQL are authoritative observed-edge records and the replay source for the Neo4j projection. Neo4j stores indexed graph entities and relationships with their source event IDs. Graph projections must be idempotent and reconstructible from committed events; graph failures must not silently disable containment.

Keep full potentially malicious fixture content in isolated artifact storage, not in event payloads broadcast to viewers. Use opaque storage references and short redacted previews.

## 8. API and real-time contract

### REST endpoints (proposed)

```text
POST /api/runs                  Create protected run (authorized developer/host)
GET  /api/runs/:id              Run status and DAG snapshot
GET  /api/runs/:id/events       Ordered event replay (cursor)
GET  /api/runs/:id/incidents    Incident list
POST /api/incidents/:id/quarantine
POST /api/incidents/:id/recovery-plan
POST /api/incidents/:id/approve-recovery
POST /api/arena/rooms          Create demo room
POST /api/arena/rooms/:id/join Join via expiring invitation
POST /api/arena/rooms/:id/actions Submit authorized, typed game action
POST /api/arena/rooms/:id/start Host-only round start
POST /api/arena/rooms/:id/reveal Host-only final reveal
```

All mutation calls validate Zod schemas, project/room role, run phase, and command idempotency key. Reject replayed actions and expired approvals.

### Socket.IO events

- `run.snapshot`: authoritative run/graph snapshot on join or reconnect.
- `run.event`: ordered incremental event `{runId, seq, type, payload}`.
- `room.presence`: participant count and public aliases (no private roles).
- `player.private_state`: **unicast** role, cards, private evidence.
- `action.result`: result for a submitting participant.
- `arena.phase`: countdown/state from server clock.
- `arena.reveal`: final attacker identity and event-backed outcome (only after round ends).

Reconnect: client sends last `seq`; API replays missing events or sends new snapshot. Never derive security decisions from what a client claims its local graph displays.

## 9. Demo round state machine

```text
LOBBY → BRIEFING → ATTACK_WINDOW → AGENT_EXECUTION
     → INVESTIGATION → CONTAINMENT → RECOVERY → REVEAL → COMPLETE
```

**Host:** Select/start/pause/reset/reveal.  
**Attacker:** One secret role, one or more scenario-approved attack cards.  
**Defenders:** Inspect/trace/share; authorized defender may quarantine/approve recovery.

For 2 players, consolidate defender capabilities. For 3–6, distribute them. Game outcome uses actual measured unsafe actions and legitimate completion, not number of flashy alerts. Optional saboteur guessing is a bonus, not the objective.

**No installation:** The Arena launches ephemeral isolated demo agents owned by the product; QR codes point to a mobile web join page. No public user can provide arbitrary shell commands or external URLs to the hosted sandbox in the MVP.

## 10. Execution sequence — incident and recovery

```text
Attacker phone  → Arena API: Poison Document card
Arena API       → Scenario Kit: update sandbox fixture (record version)
Orchestrator    → Pi Research: run task with untrusted document
Pi Research     → Artifact Broker: publish researched artifact
Broker          → Provenance: producer/source/consumer edges
Pi Builder      → Tool Gateway: request restricted operation
Tool Gateway    → Policy Engine: evaluate before dispatch
Policy Engine   → Tool Gateway: DENY (rule, reason)
Tool Gateway    → Event journal: tool.denied
Event journal   → Projector: graph alert via Socket.IO
Defender phone  → API: inspect → quarantine source
Incident Manager→ Scheduler: stop downstream task scheduling
Recovery Planner→ API: impact subgraph + rerun proposal
Defender phone  → API: approve exact recovery plan
Orchestrator    → Pi workers: affected tasks rerun on safe inputs
Verifier        → Scenario Kit: run acceptance/security checks
API             → Projector: recorded final outcomes and replay
```

## 11. Observability and evaluation

**Evaluation fixture:** Same document versions, legitimate user objective, policy configuration, model config where feasible, and synthetic tools for baseline/protected comparison. LLM nondeterminism remains; repeat runs and report variance rather than claiming identical trajectories.

Measure actual forbidden resource accesses, denied calls, legitimate task test passes, affected-task recall against fixture ground truth, rerun count, time and token use where available, and tool false blocks. Record test and model configuration along with results.

## 12. Deployment and operational boundaries

- **Local developer mode:** React SPA + Fastify server + Postgres + constrained local Docker worker(s).
- **Hosted Arena:** Static React frontend plus persistent Node backend and separate isolated demo runner. Only preapproved scenarios/fixtures run; enforce per-room quotas, session expiry, timeout, CPU/memory limits and outbound network restrictions.
- **Secrets:** Model API credentials live only in server/worker secret store. Never send to phone/browser or include in logs. Synthetic demo secrets are not real credentials.
- **Unprotected baseline:** Deliberately vulnerable fixture isolated from production resources; prominently label it as such.
- **Failure response:** Fail closed on inability to evaluate a sensitive tool operation. Surface partial completion on agent/provider errors; no fabricated successful recovery.

## 13. Reliability and safety edge cases

| Case | Response |
| --- | --- |
| Tool policy service unavailable | Deny privileged operation, log unavailable-policy event |
| Sandbox times out | Terminate isolated worker, mark execution failed, preserve incident trace |
| Quarantine races with pending call | Reauthorize at dispatch; reject quarantined dependency |
| Duplicate client command | Deduplicate by command ID and return prior result |
| Attacker disconnects | Continue round using existing submitted attack or end attack window |
| Defender disconnects | Reassign approval role to host/authorized participant; do not auto-approve |
| Dependency edge missing | Conservatively broaden invalidation or halt rather than assert safe recovery |
| Verification fails | Mark `RECOVERY_FAILED` and keep consequential operations blocked |
| Irreversible tool call | Explicit approval/pre-commit guard; never pretend it can be undone |

## 14. Architecture acceptance tests

1. **Denied before side effect:** Attempt to read synthetic restricted file; assert target audit log reports zero accesses.
2. **Agent isolation:** Research agent cannot invoke Builder's privileged tool capabilities even via delegated messages.
3. **Brokered provenance:** Artifact version consumed by Builder is linked to source and execution IDs.
4. **Quarantine closure:** Poison research artifact; Builder and Verifier invalidate, independent UI task stays validated.
5. **Recovery:** Approved rerun repairs affected tasks; checks pass and unaffected task attempt IDs remain unchanged.
6. **Role privacy:** Attacker role and private attack parameters are never broadcast to non-attacker sockets until reveal.
7. **Reconnection:** Replayed event stream yields same graph state as live rendering.
8. **Integrity:** Client cannot approve recovery by forging role or directly emitting socket events.
9. **Truthful baseline comparison:** Scores calculated from events and target-side audits.

## 15. MVP build order

**First:** sandbox + policy gate + real Pi-backed restricted-tool attempt.  
**Second:** broker + Neo4j knowledge graph projection + 3-task workflow with independent branch.  
**Third:** quarantine + deterministic DAG invalidation + verified rerun.  
**Fourth:** Fastify/Socket.IO + React/Vite dashboard.  
**Fifth:** QR Arena + role cards + live security graph + reveal.  
**Finally:** paired baseline/protected runs, evaluation, animations, and demo rehearsal.

**Implementation rule:** Prioritize an end-to-end real security event over additional UI effects or unimplemented attack types.

## 16. Deferred architectural extensions

T3 Code/Codex adapters; generalized MCP proxy integration; durable distributed job queue; Redis pub/sub; object-store artifacts; broad data-flow classification; multi-tenant authorization; robust compensating transactions; other threat scenarios. These are **not** part of MVP security claims.
