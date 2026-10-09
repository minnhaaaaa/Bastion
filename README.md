# Bastion — Team RAM (Tathack)

An agent workspace with security built in. A security-native multi-agent orchestrator that can **trace, contain, and recover** from compromised agent outputs.
*Stop the breach. Save the workflow.*

- Product & scope: [PLAN.md](PLAN.md)
- System design: [ARCHITECTURE.md](ARCHITECTURE.md)
- Stack: [TECH_STACK.md](TECH_STACK.md)
- **Who does what + shared contracts: [TEAM_PLAN.md](TEAM_PLAN.md)**
- Security architecture: [below](#security-architecture) · acceptance tests: [ACCEPTANCE.md](ACCEPTANCE.md)

> **Zero hardcoded data.** No mock events, fixtures, sample runs, hardcoded workflows or default config in code.
> Workflows are submitted through the API and stored in Postgres; config comes from `.env`; everything is real-time.
> Test data is allowed only inside automated tests. See TEAM_PLAN.md → Rule #1.

## Security architecture

How Bastion protects agent workflows. Bastion does **not** claim to stop every vulnerability; each control is placed at a boundary the system actually enforces. Scope and limits are listed under the diagrams.

### System architecture and enforcement boundaries

```mermaid
flowchart TB
  %% ───────────── Untrusted clients ─────────────
  subgraph Clients["Untrusted clients"]
    OP["Operator console<br/>(React + Barba + GSAP)"]
    HOST["Arena host / projector"]
    PLAYER["Arena players (phones, QR join)"]
    CLI["Workflow CLI<br/>(pnpm workflow:submit)"]
  end

  %% ───────────── Control plane ─────────────
  subgraph API["Fastify control plane (apps/api)"]
    AUTH["Bearer auth<br/>operator / host / player tokens<br/>(hashed; die with the room)"]
    VALID["Zod validation of every command<br/>WorkflowDefinition checks: refs, cycles, trust"]
    IDEM["commandId idempotency<br/>(replays return stored result)"]
    RATE["Rate limits on join / actions"]
    ACCESS["Ownership checks<br/>project owner / room member"]
    SOCK["Socket.IO: read-only fan-out<br/>gap-free seq, lastSeq replay"]
    ARENA["Arena service<br/>private roles, server-clock phases,<br/>reveal gating, card reassignment"]
  end

  %% ───────────── Authoritative state ─────────────
  subgraph STATE["Authoritative state (Postgres)"]
    JOURNAL[("Event journal<br/>append-only, per-run seq,<br/>persist before broadcast")]
    TABLES[("Materialised tables<br/>runs, tasks, artifacts, edges,<br/>incidents, approvals, tool_approvals")]
  end

  GRAPH[("Neo4j knowledge graph<br/>idempotent projection,<br/>impactSet cross-check")]

  %% ───────────── Runtime ─────────────
  subgraph RUNTIME["Agent runtime"]
    RUNNER["WorkflowRunner<br/>pinned workflow version,<br/>sources loaded before attacks"]
    SCHED["Scheduler (DAG)<br/>runs only on usable inputs,<br/>hold / rerun"]
    AGENTS["Pi agent sessions<br/>Research / Builder / Verifier<br/>(built-in tools disabled)"]
    BROKER["Artifact broker<br/>hash + version + provenance edges,<br/>refuses quarantined inputs,<br/>redacted previews only"]
  end

  subgraph GATE["Policy boundary"]
    GW["Tool gateway<br/>identity from journal, never the model;<br/>normalise → evaluate → re-check → execute"]
    POLICY["Deterministic policy engine<br/>agent capabilities ∩ workflow rules,<br/>default DENY"]
    FENCE["Execution fence<br/>shared by dispatch, hold, quarantine"]
    TAPPROVE["Tool approvals (REQUIRE_APPROVAL)<br/>digest-bound, single-use CAS,<br/>expire / cancel, human operator only"]
  end

  subgraph SANDBOX["Isolated sandbox (Docker)"]
    WORKER["Worker<br/>internal network only (no egress),<br/>read-only FS, caps dropped,<br/>exec allowlist, no shell"]
    WAUDIT[("Worker access audit<br/>outside agent workspace")]
    TARGET["Internal target services<br/>(own audit log)"]
  end

  subgraph RECOVERY["Incident response"]
    INCIDENT["Auto-incident on DENY<br/>traced to untrusted upstream source"]
    QUAR["Quarantine (human)<br/>synchronous in Postgres, under fence,<br/>hold + invalidate descendants"]
    PLAN["Recovery plan<br/>topological rerun, preserved set,<br/>sha256 digest"]
    APPROVE["Recovery approval<br/>human-only, single-use, expiring"]
    VERIFY["Verifier<br/>state checks + target audit +<br/>SOURCE_QUOTE acceptance checks"]
  end

  %% ───────────── Flows ─────────────
  OP & HOST & PLAYER & CLI -->|HTTPS| AUTH
  AUTH --> RATE --> VALID --> IDEM --> ACCESS
  ACCESS --> ARENA
  ACCESS -->|start run| RUNNER
  SOCK -.->|events only after commit| OP & HOST & PLAYER

  RUNNER --> SCHED --> AGENTS
  AGENTS <-->|consume / publish| BROKER
  BROKER -->|events| JOURNAL
  AGENTS -->|every file / net / exec call| GW
  GW --> POLICY
  GW --- FENCE
  POLICY -->|ALLOW| WORKER
  POLICY -->|REQUIRE_APPROVAL| TAPPROVE
  TAPPROVE -->|approved once| WORKER
  POLICY -->|DENY, logged| JOURNAL
  WORKER --> TARGET
  WORKER --> WAUDIT

  JOURNAL --> TABLES
  JOURNAL -->|projector| GRAPH
  JOURNAL --> SOCK

  JOURNAL -->|tool.decided DENY| INCIDENT
  INCIDENT --> QUAR
  QUAR -->|hold| SCHED
  QUAR --- FENCE
  GRAPH -.->|cross-check only| QUAR
  QUAR --> PLAN --> APPROVE -->|rerun affected only| SCHED
  SCHED --> VERIFY
  WAUDIT --> VERIFY
  VERIFY -->|RECOVERED / RECOVERY_FAILED| JOURNAL

  classDef untrusted fill:#2a1416,stroke:#e3172e,color:#ede6e1;
  classDef boundary fill:#5c0c17,stroke:#e3172e,color:#ede6e1;
  classDef store fill:#161012,stroke:#a2938f,color:#ede6e1;
  class OP,HOST,PLAYER,CLI,AGENTS untrusted;
  class GW,POLICY,FENCE,TAPPROVE,WORKER,QUAR,APPROVE boundary;
  class JOURNAL,TABLES,GRAPH,WAUDIT store;
```

### Threat → control map

```mermaid
flowchart LR
  subgraph Threats
    T1["Prompt injection<br/>(poisoned document)"]
    T2["Unsafe tool use /<br/>privilege escalation"]
    T3["Data exfiltration /<br/>SSRF"]
    T4["Compromised output<br/>spreading downstream"]
    T5["Forged identity /<br/>agent self-approval"]
    T6["Client tampering<br/>(forged roles, replayed commands)"]
    T7["Race: quarantine vs<br/>in-flight tool call"]
    T8["Hallucinated claims"]
    T9["Crash / restart<br/>mid-incident"]
    T10["Arena abuse<br/>(spam, role leaks)"]
  end

  subgraph Controls
    C1["Trust labels + heuristic alert<br/>(detection best effort)"]
    C2["Default-deny policy gate:<br/>capabilities ∩ workflow rules"]
    C3["Sandbox: internal network,<br/>origin + exec allowlists,<br/>target-side audit"]
    C4["Provenance graph +<br/>quarantine + selective rerun"]
    C5["Server-derived identity;<br/>human-only, digest-bound,<br/>single-use approvals"]
    C6["Bearer auth, Zod, ownership,<br/>commandId idempotency,<br/>read-only sockets"]
    C7["Shared execution fence +<br/>re-check usability at dispatch"]
    C8["SOURCE_QUOTE checks →<br/>claim.unverified"]
    C9["Boot reconciliation:<br/>fail in-flight work honestly,<br/>adopt contained runs,<br/>expire pending approvals"]
    C10["Rate limits, hashed tokens,<br/>private unicast roles,<br/>expiry sweep"]
  end

  T1 --> C1 & C2 & C4
  T2 --> C2 & C3 & C5
  T3 --> C2 & C3
  T4 --> C4
  T5 --> C5
  T6 --> C6
  T7 --> C7
  T8 --> C8
  T9 --> C9
  T10 --> C10
```

### Scope and limits

- **Prompt-injection detection is heuristic.** The guarantee is that injected instructions cannot make a *mediated* tool call do anything the policy denies.
- **Out of scope:** sandbox container escape, attacks on model weights, and tool calls that bypass the gateway.
- **Verified:** sandbox network isolation (`tests/sandbox.docker.test.ts`) and the deny/quarantine/recovery path end to end (`apps/api/src/runtime/runtime.e2e.test.ts`). See [ACCEPTANCE.md](ACCEPTANCE.md).
- **Not yet verified:** runs with a real LLM provider. `TOOL` acceptance checks fail closed until the scheduler runs them inside the verifier task.

## Quickstart

Requires Node 22+, pnpm 10+, Docker. On macOS without Docker Desktop: `brew install colima docker docker-compose && colima start` (add `/opt/homebrew/lib/docker/cli-plugins` to `cliPluginsExtraDirs` in `~/.docker/config.json`).

```bash
pnpm install
cp .env.example .env          # fill in every value; apps refuse to start without them
docker compose up -d          # Postgres 16 + Neo4j 5 (credentials/ports from .env)
pnpm db:migrate               # apply packages/db/migrations
pnpm test                     # contracts + api tests
pnpm dev                      # web + api
```

## Layout

```
apps/web            React + Vite SPA (landing, console, arena)
apps/api            Fastify + Socket.IO control plane
packages/contracts  Zod schemas: ids, enums, entities, workflow, events, commands, sockets, ports, reducer
packages/db         Drizzle schema + migrations
packages/*          orchestrator, runtime-adapter, runtime-pi, security, provenance,
                    knowledge-graph, recovery, scenario-kit
sandbox/            Docker worker + isolated target services
```
