# SPLITBRAIN — Finalized Project Plan

**Track:** Safe & Trustworthy AI  
**Status:** Architecture baseline / hackathon MVP  
**Date:** 9 October 2026  
**Pitch:** **A security-native multi-agent orchestrator that can trace, contain, and recover from compromised agent outputs.**  
**Demo tagline:** *Stop the breach. Save the workflow.*

## 1. Product overview

SPLITBRAIN is a small multi-agent orchestration system that **reuses Pi as the agent execution harness**, while implementing security at the coordination and tool-execution boundaries. It is **not** a new LLM, a Pi replacement, a T3 Code clone, or a universal MCP firewall.

It has three connected experiences built on **one runtime**:

1. **SPLITBRAIN Core (real product):** Run collaborating agents with task dependencies, agent-scoped capabilities, mediated artifact exchange, pre-execution tool authorization, a provenance knowledge graph, incident containment, and task-level selective recovery.
2. **Developer Console (real product UI):** Observe the running agent graph, inspect security decisions and incidents, review pending approvals, and authorize recovery.
3. **Arena (landing-page live demo):** Visitors join from phones via QR codes to attack or defend a *sandboxed instance of the same runtime*. Actions update a shared, projected security graph in real time.

**Primary success claim:** For the supported workflow and threat model, SPLITBRAIN denies prohibited actions at execution boundaries and identifies/recomputes recorded downstream dependencies after a source is quarantined. It does **not** promise to eliminate every hallucination, jailbreak, or prompt injection.

## 2. Problem and solution

**Problem:** A malicious document or tool response can enter one agent's context, contaminate outputs consumed by other agents, and influence apparently authorized downstream actions. A single-agent scanner or per-tool decision alone doesn't explain which other artifacts relied on the source or how to resume useful work safely.

**Solution:** Make security native to task delegation and information handoffs:

- **TRACE:** Maintain a queryable provenance **knowledge graph** linking agent identities, tasks, source documents, artifact versions, tool calls, permissions and incidents, backed by an inspectable event log.
- **CONTAIN:** Enforce scoped permissions, block prohibited tool calls, quarantine questionable sources, and pause dependent tasks before irreversible actions.
- **RECOVER:** Compute the downstream dependency closure; preserve unaffected validated outputs; rerun affected idempotent tasks from safe inputs and verify their outputs.

## 3. Audience and positioning

- **Developer:** Defines a workflow in a TypeScript SDK/CLI; runs Pi-backed agents through SPLITBRAIN; uses a React console for monitoring and incident response.
- **Security engineer:** Defines policies, examines why an action was allowed or denied, traces evidence, and reviews recoveries.
- **Demo visitor/judge:** Joins an arena room without installing software and experiences a real, isolated agent workflow under attack.

**Positioning:** Security-native orchestration **around** existing agent harnesses. Pi is the first adapter. T3 Code / other agent frameworks are future integration targets, not claims of supported integration at launch.

## 4. Scope — what is actually being built

### P0: Required for a credible MVP

- Three Pi-backed roles: **Research**, **Builder**, **Verifier** (with one independent task branch).
- A TypeScript DAG orchestrator: tasks, dependencies, status, assignment, retries and explicit checkpoint/artifact versions.
- A constrained `AgentRuntimeAdapter` abstraction with **one working Pi implementation**.
- Central **Artifact Broker**: all cross-agent shared artifacts flow through it with provenance metadata.
- Agent capability profiles and a **deterministic** pre-execution policy gate for supported filesystem/network/tool operations.
- Containerized sandbox with **synthetic data**, deny-by-default egress, and an intentionally vulnerable baseline run used only for comparison.
- Append-only structured events, causal IDs, trust labels, quarantines, and **Neo4j knowledge-graph traversal** of observed inter-agent dependencies.
- Task-level containment and selective rerun, with explicit human approval for recovery.
- React/Vite developer console and projected Arena graph; REST + Socket.IO live event feed.
- QR-code join for **2–6 participants**, mobile action cards, round controller, and scoreboard based on recorded events.
- At least one automated integration test proving deny-before-execute and one proving only affected DAG nodes are rerun.

### P1: Quality and judge experience

- Polished animations, source-inspection panels, event replay and side-by-side *vulnerable vs protected* comparisons.
- Additional cards demonstrating confidential-data egress and an unsupported-claim verification warning.
- Measured metrics for tool blocks, task completion, rerun count, latency, and tokens if provider metadata permits.
- Disconnect/rejoin, permissions by role, and deterministic fallback **clearly labeled recorded replay**.

### P2: After the hackathon

- T3 Code/Codex adapters, external agent registration, broader MCP integration, policy templates, hosted organizations, more granular state recovery, benchmarks across workflows, and distributed workers.

### Explicit non-goals

- Training or changing a foundation model; automatic elimination of all hallucinations/jailbreaks.
- Perfect semantic causal inference into LLM internals.
- Arbitrary rollback of already-executed external side effects.
- Securing unmediated third-party tool calls or arbitrary local processes.
- Production-ready, multi-tenant hosted execution for untrusted customer code in the MVP.

## 5. Product experience

### Landing page

**Hero:** “Your agents collaborate. We keep them safe.”  
Buttons: **Try Live Arena** and **Launch Developer Console**. Below: an event-driven graph preview and three capabilities: Trace / Contain / Recover.

### Developer flow

1. Developer defines agents, trusted sources, capabilities and task graph in a configuration/SDK.
2. Local runner starts Pi-backed agent sessions inside an isolated demo execution environment.
3. All inter-agent artifacts and mediated tool calls pass through SPLITBRAIN control points.
4. Developer opens the React console to inspect graphs, policies and security events.
5. On a flagged incident, the system blocks hard-policy violations automatically; quarantine and recovery require permission/approval according to policy.

### Arena: clear objective and roles

**Main objective for defenders:** Prevent an unsafe action **and still complete** the legitimate workflow.  
**Main objective for attacker:** Make the protected workflow commit an unsafe action.  
**Optional bonus:** Correctly identify the attacker (not required for winning).  
**Game duration target:** 3–5 minutes per round; backend execution may vary.

**Variable-player role allocation:** 2 players = 1 attacker + 1 defender (all defender controls); 3–6 = 1 attacker + remaining defenders with distributed investigative and recovery controls. Host is separate from active players. No mandatory typing.

**Attack cards:** Poison Document (P0, real implementation), Redirect Tool (P1), Leak Synthetic Secret (P1). Attacker picks target/source; candidate untrusted content is installed into a fixture. Attacks are not scripted to always succeed.

**Defender cards:** Inspect Source, Trace Dependency, Review Tool Decision, Quarantine, Approve Recovery, Share Evidence. Some actions delegate *real* scoped forensic tasks; quarantine and approvals are role-authorized controller actions, not free-form model instructions.

**Projector:** Animated React Flow DAG of source → agent task → artifact → downstream task → tool call; events are backend-grounded. Public view never reveals private attacker identity or unrevealed evidence before round completion.

## 6. Signature scenario — “Poisoned Docs → Unsafe Request”

The demo operates entirely in a **sandboxed fictional software project**.

1. Research agent reads developer documentation from an untrusted fixture source.
2. A human attacker selects a Poison Document card, injecting misleading tool-use instructions into that fixture.
3. Research continues and may pass compromised content to Builder. The graph records **observed consumption** and downstream artifacts; it does not assert model-internal causality.
4. The attacker tries to cause a restricted sandbox request (or synthetic-secret read). The instrumented tool sends the proposed action to the security policy engine **before execution**.
5. Hard policy denies the prohibited call. An alert appears, but not the attacker identity.
6. Defenders inspect evidence. An authorized player quarantines the source; dependent tasks pause, while the independent branch stays complete.
7. Recovery planner calculates invalidated task descendants; authorized user approves selective rerun with trusted replacement input.
8. Verifier runs predefined acceptance/security tests. Dashboard reports actual completion/failure and incident trace.
9. Host displays an **isolated intentionally vulnerable baseline** and protected run using the same attack fixture; score reflects measured outcomes, not canned numbers.

**Demo rule:** The product must still be understandable when the attack fails early: show *attempted → denied* and why. Never fabricate a breach or successful recovery for effect.

## 7. Track 2 coverage (truthful claims)

| Risk | MVP approach | Claim strength |
| --- | --- | --- |
| Prompt injection | Untrusted-source labeling, pattern/optional classifier alert, action-level rules | Detection is best-effort; tool restrictions are enforceable |
| Unsafe tool use | Capability checks and path/destination allowlists | Enforced only for controlled tool boundaries |
| Data leakage | Synthetic-secret label and outbound destination rules | Enforced for mediated channels; no universal exfiltration guarantee |
| Model auditing | Event ledger, evidence graph, policy decision reason, replay | Recorded observable behavior, not internal reasoning |
| Hallucinations | Optional evidence-backed verification of selected claims | Flag/verify limited claims; not solved generally |
| Jailbreaks | Optional detectors + external tool policy limits | Can restrict effects, not prevent all text jailbreaks |

SSRF is demonstrated only against **synthetic isolated HTTP services** and only through a mediated request tool.

## 8. Delivery phases and gates

### Phase 0 — Definitions and baseline
- [ ] Create synthetic repository, trust boundaries, blocked action policy, protected/unprotected fixtures.
- [ ] Freeze one DAG and one attack path; define measured success/failure outcomes.

### Phase 1 — Vertical slice (first priority)
- [ ] `Research → Builder → Verifier` plus independent branch completes without an attack.
- [ ] Pi adapter launches agents and records tool proposals/executions.
- [ ] Blocked synthetic-sensitive tool request never reaches resource.
- [ ] Persist input/artifact/task dependencies and event log.

### Phase 2 — Response and recovery
- [ ] Quarantine a source; suspend dependents and prevent new affected action execution.
- [ ] Verify independent completed branch stays preserved.
- [ ] Recompute affected tasks on trusted replacement, then run acceptance checks.

### Phase 3 — Developer UI + arena
- [ ] React graph with replayable recorded events.
- [ ] Room QR, 2–6 players, private role screens, action cards and shared scoreboard.
- [ ] Human actions drive actual scenario API commands; host controls start/reset/reveal.

### Phase 4 — Evaluation, polish, delivery
- [ ] Baseline vs protected paired runs; export traces.
- [ ] Test failure, timeout, disconnected players, missing evidence, denied recovery.
- [ ] Record a fallback walkthrough marked **recorded run**.
- [ ] README, install instructions, threat model, demo script, evidence of measured outcomes.

## 9. Acceptance criteria

- [ ] A Pi-backed three-agent workflow completes successfully in the normal case.
- [ ] Attack card modifies a genuine sandbox fixture before agent consumption.
- [ ] The policy engine blocks the defined forbidden request **before** resource access.
- [ ] The Neo4j knowledge graph contains provenance with versioned artifact IDs, typed relations, trust labels, and trace IDs.
- [ ] Quarantine suspends affected tasks and prevents reuse of quarantined artifact versions.
- [ ] Only the affected tasks are rerun; at least one independent completed task remains untouched.
- [ ] A human-controlled defender can approve recovery from a phone.
- [ ] At least 2 and at most 6 phones can join; room role privacy holds.
- [ ] On-screen event data is obtained from persisted backend events.
- [ ] Protected and unprotected comparative outcomes are measured on identical fixtures.
- [ ] Demo does not access real secrets, third-party infrastructure, or uncontrolled networks.

## 10. Evaluation metrics

- **Unsafe action execution rate:** forbidden operations that actually reach the sandbox target.
- **Legitimate task completion:** predefined tests and deliverable requirements satisfied.
- **Quarantine coverage:** fraction of known affected descendants invalidated (fixture ground truth).
- **Recovery efficiency:** number of rerun tasks vs full restart/checkpoint baseline.
- **False blocking:** permitted tool operations incorrectly denied.
- **Overhead:** event size, latency, tokens/cost where available.
- **Demo reliability:** repeatable successful runs and timeouts/reconnections handled.

No numeric improvement claims until benchmark runs produce numbers.

## 11. Risks and mitigations

| Risk | Response |
| --- | --- |
| Pi hook doesn't cover all actions | Only advertise enforcement for hooked/controlled tools; restrict runtime filesystem/network independently |
| Tool bypass | Isolated container, least privileges, denied outbound traffic, read-only mounts where possible |
| Trust labels imply semantic certainty | Label observed dependencies; mark inferred contamination as suspected |
| Recovery repeats side effects | Scope to idempotent task-level workflows with checkpoints; block external irreversible effects |
| Too much infrastructure | Single backend process, Postgres and Socket.IO; no Redis initially |
| LLM/network latency | Bounded stages, synthetic fixtures, clear progress; recorded fallback labeled honestly |
| Game distracts from product | One sentence objective, role-specific buttons, security autopsy after each round |

## 12. Agreed design decisions

- **Frontend:** **React + TypeScript + Vite** (not Next.js), Tailwind CSS, shadcn/ui, React Flow.
- **Backend:** TypeScript / Node.js + Fastify + Socket.IO.
- **Agent harness:** Pi first; adapter interface for future runtimes.
- **Orchestration:** Custom lightweight task DAG and controlled artifact broker, with graph projection into Neo4j.
- **Persistence:** PostgreSQL + Drizzle for authoritative transactions/events; **Neo4j** for the provenance/security knowledge graph; no Redis in MVP.
- **Local execution:** Sandbox in Docker; hosted demo only with isolated controlled scenarios.
- **Autonomy:** Agents perform bounded tasks; hard policies enforce themselves; sensitive/irreversible actions and recovery approvals require a human.
- **Files:** `ARCHITECTURE.md` documents boundaries and protocols; `TECH_STACK.md` pins technology choices and implementation assumptions.
