# Acceptance tests → automated tests

The architecture acceptance tests (ARCHITECTURE §14) are all automated. Run them with `pnpm test`.

| # | Requirement | Test(s) |
|---|---|---|
| 1 | **Denied before side effect:** a restricted access is denied and the target audit shows zero accesses | `apps/api/src/runtime/runtime.e2e.test.ts` › *protected: … exfil denied before execution (audit + target empty)*; `packages/runtime-pi/src/audit.test.ts` |
| 2 | **Agent isolation:** an agent cannot use another agent's capabilities, even through delegated identity | `runtime.e2e.test.ts` › *acceptance #2*; `packages/security/src/security.test.ts` |
| 3 | **Brokered provenance:** a consumed artifact version is linked to its source and execution IDs | `packages/provenance/src/broker.test.ts` › *records observed provenance* |
| 4 | **Quarantine closure:** the poisoned path is invalidated, the independent task stays valid | `packages/recovery/src/recovery.test.ts`; `runtime.e2e.test.ts` › *protected* |
| 5 | **Recovery:** an approved rerun repairs affected tasks, checks pass, unaffected attempt IDs are unchanged | `recovery.test.ts`; `runtime.e2e.test.ts` › *protected*, *restart mid-incident*; `packages/orchestrator/src/scheduler.test.ts` |
| 6 | **Role privacy:** the attacker's role is never sent to anyone else before reveal | `apps/api/src/acceptance.test.ts` › *acceptance #6*; `api.test.ts` › *Arena* |
| 7 | **Reconnection:** replaying the event stream gives the same state as live rendering | `packages/contracts/src/contracts.test.ts` › *incremental application equals full replay*; `api.test.ts` › *Socket.IO … lastSeq replay* |
| 8 | **Integrity:** clients cannot approve by forging roles or emitting socket events | `acceptance.test.ts` › *acceptance #8*; `api.test.ts` › *requires auth*; `recovery.test.ts` (agent actors rejected) |
| 9 | **Truthful baseline comparison:** scores come from events and target-side audits | `runtime.e2e.test.ts` › *baseline*, *compare + metrics + export* |

The live Neo4j check (`packages/knowledge-graph/src/neo4j.integration.test.ts`) runs only when `NEO4J_TEST_URI` is set.
