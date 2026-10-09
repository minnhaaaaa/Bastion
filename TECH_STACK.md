# Bastion — Finalized Technology Stack

**Date:** 9 October 2026 · **Track:** Safe & Trustworthy AI  
**Architecture:** React/Vite SPA + TypeScript API + security-native task orchestration + Pi-backed isolated workers.

## 1. Final choices

| Layer | Technology | Why / usage |
| --- | --- | --- |
| **Web frontend** | **React + TypeScript + Vite** | Landing page, dashboard, Arena host/projector and mobile player screens; **no Next.js** |
| Styling | Tailwind CSS v4 + shadcn/ui | Fast, accessible components and responsive mobile controls |
| Navigation | React Router | Browser routes across SPA surfaces |
| Data fetching | TanStack Query | API cache, loading, retries, mutations |
| Graph visualization | `@xyflow/react` (React Flow) | Render backend knowledge-graph projections and live events; visualization is not the database |
| **Knowledge graph** | **Neo4j + official JavaScript driver (`neo4j-driver`)** | Typed provenance, agent, task, artifact, resource, tool-call, policy and incident relationships; Cypher impact queries |
| Animation | Motion for React (formerly Framer Motion) | Event-driven UI transitions; no required 3D stack |
| QR | `qrcode` (or `react-qr-code`) | Room-specific invite URLs |
| API/backend | Node.js + TypeScript + Fastify | REST endpoints, orchestration control plane and security policy API |
| Realtime | Socket.IO | Room membership and event updates; socket messages never authorize security actions by themselves |
| Agent harness | Pi SDK (`@mariozechner/pi-coding-agent` ecosystem; verify exact package APIs at integration) | LLM turns/tool handling; do not reinvent the harness |
| Runtime integration | Custom `AgentRuntimeAdapter` | Initial Pi implementation, future alternate harnesses |
| Orchestrator | Custom TypeScript DAG scheduler | Dependency-safe task runs, retries, checkpoint references |
| Authorization | Custom deterministic policy module + Zod | Explicit agent/tool/resource/operation rules; deny by default |
| Provenance | Versioned artifact broker + append-only events | Recorded agent handoffs and possible downstream impact |
| Recovery | Custom task-level invalidation/rerun | Only for checkpointed, repeatable controlled tasks |
| Transactional data store | PostgreSQL + Drizzle ORM | Authoritative runs, tasks, artifacts, events, policies, rooms; replayable graph-edge facts |
| Validation/contracts | Zod | Shared request/event/command schemas |
| Sandbox | Docker containers, egress-denied network, synthetic fixture services | Boundary independent of LLM and hooks |
| Unit/integration tests | Vitest | Policy, DAG invalidation, adapters, API |
| Browser tests | Playwright | QR join, roles, approvals, projection, live game |
| Monorepo | pnpm workspaces + Turborepo | Shared types and coordinated builds |
| Logs/telemetry | Pino; optional OpenTelemetry | Correlatable trace IDs; no secrets in logs |
| Deployment | Static host for Vite SPA; persistent Node container host for API; managed Postgres + Neo4j; isolated worker host | API cannot run as static/serverless-only if managing long-lived agents |

**Versions:** Use compatible current stable releases and commit exact resolved versions in `pnpm-lock.yaml`. The named Pi package/API must be verified against upstream during implementation rather than assumed to support arbitrary interception or rollback.

## 2. Why Vite React rather than Next.js?

The project is a client-heavy, live-update application: React Flow projected visualization, mobile game controllers, and developer console. It does not need server-side rendering for the MVP. Vite yields a simple deployable SPA with Fastify as the separate backend. Landing-page SEO/SSR can be added later if needed.

**React routes:** `/`, `/arena`, `/arena/:roomId`, `/arena/:roomId/host`, `/dashboard`, `/runs/:runId`, `/incidents/:incidentId`, `/policies`, `/integrations`.

Use the SPA host's fallback rewrite to `index.html` for client routes.

## 3. Final monorepo layout

```text
bastion/
├── apps/
│   ├── web/                    # React + Vite SPA, all web surfaces
│   │   └── src/
│   │       ├── pages/          # landing, arena, dashboard, incidents
│   │       ├── features/       # graph, policies, rooms, incident inspector
│   │       └── components/
│   └── api/                    # Fastify + Socket.IO control plane
│       └── src/
│           ├── routes/
│           ├── sockets/
│           └── workers/
├── packages/
│   ├── contracts/              # Shared Zod types, commands/events
│   ├── orchestrator/           # DAG scheduler, state machine
│   ├── runtime-adapter/        # Framework-neutral interface
│   ├── runtime-pi/             # Pi-backed adapter
│   ├── security/               # Tool/recipient/path policy rules
│   ├── provenance/             # Artifacts, trust metadata, graph edges
│   ├── recovery/               # Quarantine and selective rerun
│   ├── scenario-kit/           # Synthetic demo workflows and tests
│   └── db/                     # Drizzle schemas/migrations
├── sandbox/                    # Dockerfiles, test services and fixtures
├── tests/                      # Cross-package integration/e2e
├── PLAN.md
├── ARCHITECTURE.md
└── TECH_STACK.md
```

## 4. Runtime decisions

- **One TypeScript backend** for hackathon MVP; workers may be child processes or isolated containers controlled by it.
- **Separate Pi sessions per role**, with separate tool grants and workspace views; all trusted inter-agent exchanges use the artifact broker.
- **Security checks before tool execution**; sandbox independently prevents filesystem/network bypass where possible.
- **Postgres owns authoritative execution and policy state**; **Neo4j holds the queryable knowledge-graph projection**; Socket.IO broadcasts view projections. Clients do not write trusted state directly.
- **Knowledge-graph writes** occur through an idempotent backend projector fed by committed events, not directly from clients. If Neo4j lags, hold safety-sensitive actions or conservatively widen containment; never fail open.
- **Backend event IDs and sequence numbers** support replay, reconnect, and idempotent commands.
- **Neo4j is required** for the knowledge graph. No Redis, Kubernetes, LangGraph, GPU inference, or Three.js required for the MVP.
- **LLM provider:** Configurable via Pi; store API keys server-side only, never in browser or demo participants' devices.

## 5. Test and development commands (planned)

```bash
pnpm install
pnpm dev                   # turbo starts web + api
pnpm build
pnpm lint
pnpm test                  # Vitest
pnpm test:e2e              # Playwright
pnpm db:migrate            # Drizzle migrations
pnpm scenario:baseline     # Run synthetic unprotected fixture
pnpm scenario:protected    # Run same fixture with policies enabled
```

Scripts must be implemented in the repository; these are the intended developer interface, not already-existing commands.

## 6. Security engineering rules

1. Never treat the LLM as the policy decision maker.
2. Default-deny privileged tools and all unneeded outbound network connections.
3. Apply least privilege to container mounts and runtime credentials.
4. Record what was **observed**, distinguishing it from inferred semantic influence.
5. Public Arena uses **only synthetic credentials/data** and an isolated target service.
6. Validate every websocket/HTTP command against room membership and role-based authorization.
7. Never claim unsupported safety coverage; show actual test outcomes.
8. **Zero hardcoded data.** Nothing in the codebase may contain hardcoded data: no canned events, mock streams, fixture JSON, sample runs, hardcoded agents/tasks/sources/capabilities/policy rules, fallback hosts/ports/credentials, or placeholder numbers in the UI. Workflows (agents, tasks, sources, capabilities, policy rules, attack payloads) are data submitted via `POST /api/workflows` and stored in Postgres; configuration comes only from required environment variables; everything the UI shows is real-time from persisted backend events. Test doubles and generated test data are allowed **only inside automated tests**. Demo content will be decided later and will also be loaded as data, not code.

## 7. Integration priorities

**P0:** Pi-based workflow + synthetic repository, one mediated unsafe tool, **Neo4j knowledge graph** of provenance and dependencies, and task recovery.  
**P1:** Rich multi-user Arena and additional threat scenarios.  
**P2:** T3 Code/Codex adapters if supported public integration interfaces are confirmed.
