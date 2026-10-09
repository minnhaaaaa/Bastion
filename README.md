# Bastion — Team RAM (Tathack)

An agent workspace with security built in. A security-native multi-agent orchestrator that can **trace, contain, and recover** from compromised agent outputs.
*Stop the breach. Save the workflow.*

- Product & scope: [PLAN.md](PLAN.md)
- System design: [ARCHITECTURE.md](ARCHITECTURE.md)
- Stack: [TECH_STACK.md](TECH_STACK.md)
- **Who does what + shared contracts: [TEAM_PLAN.md](TEAM_PLAN.md)**

## Quickstart

Requires Node 22+, pnpm 10+, Docker.

```bash
pnpm install
cp .env.example .env
docker compose up -d          # Postgres 16 + Neo4j 5
pnpm db:migrate               # apply packages/db/migrations
pnpm test                     # contracts + api tests
pnpm dev                      # web on :5173, api on :4000
```

Without Docker, the web app still runs: it replays `packages/contracts/fixtures/demo-run.events.json`.

## Layout

```
apps/web            React + Vite SPA (landing, console, arena)
apps/api            Fastify + Socket.IO control plane
packages/contracts  Zod schemas: ids, enums, entities, events, commands, sockets, ports, reducer, fixture
packages/db         Drizzle schema + migrations
packages/*          orchestrator, runtime-adapter, runtime-pi, security, provenance,
                    knowledge-graph, recovery, scenario-kit
sandbox/            Docker worker + synthetic fixture services
```
