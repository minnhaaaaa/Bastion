# Security boundaries after hardening

The controller enforces configured permissions; it does not promise universal prompt-injection immunity or factual correctness. The shared contracts are unchanged.

## Required deployment configuration

Compose requires explicit `POSTGRES_PUBLISH_HOST` and `NEO4J_PUBLISH_HOST` addresses. Bind local development databases to loopback; select other addresses only with suitable network access controls. Database ports are no longer implicitly published on every interface.

`API_BIND_HOST` is explicit. `API_SECURITY_JSON` must specify positive integer budgets for `requestsPerMinute`, `maxSocketsPerActor`, `socketMessagesPerMinute`, `maxRunSubscriptions`, `maxReplayEvents`, `maxBufferedEvents`, `maxConcurrentExpensiveRequests`, `maxActiveRunsPerOwner`, `maxWorkflowTasks`, `maxWorkflowSources`, and `maxWorkflowRules`. There are no production defaults. Rate limits apply globally; Arena keeps its tighter route limits. Authenticated POST concurrency is bounded, and run admission is serialized per owner so concurrent starts cannot exceed the active-run quota.

`RUNTIME_SECURITY_JSON` must specify:

- `modelOrigins`: exact approved provider origins, checked for controller, selected agent models, and planning.
- `modelClassifications`: classifications explicitly approved for disclosure to those providers. Exclude secret classifications when their content must stay local. A classification label does not prevent disclosure to an explicitly approved recipient.
- `operationClassifications`: allowed input classifications for each tool operation. Missing operations are denied. Exclude sensitive classifications from network and process operations unless their disclosure is intended.
- `toolOutputClassifications`: operator-declared classification of each operation's result. Missing result classifications are denied. Successful tool results taint subsequent requests; output artifacts inherit classifications of successful tool operations as well as input classifications.
- `approvalOperations`: operations requiring exact human approval even when the workflow permits them. Include side-effecting operations so recovery reruns also require fresh review. Human approval cannot override a classification denial.

`SANDBOX_EXEC_COMMANDS` now contains exact `{executable, argv}` pairs. Executable-only entries are rejected. Every argument must match, with no shell or caller-selected environment. Grant only trusted operations; approving an interpreter with code arguments approves that exact code and its effects. An empty array disables process tools.

## Enforced behavior

| Concern | Current behavior |
| --- | --- |
| Windows repository traversal | Both path separators are checked before Git enumeration and after canonicalization. |
| Confidential previews | Non-public source and artifact previews are empty, including inherited classification. Non-public model finding explanations and approval target previews are withheld from public events. Authorized owners can retrieve usable artifact content separately. Regex redaction is supplemental. |
| Model disclosure | Unapproved destinations and classifications fail before runtime invocation. Source classifications must accurately reflect submitted data; arbitrary user text and incorrectly labelled data cannot be automatically classified with certainty. |
| Tool-result leakage | Recorded successful tool operations raise the calling execution's effective classification. Classification restrictions are re-evaluated before dispatch and approval execution. |
| Untracked file reads | Protected reads must match a consumed declared source. Returned contents must match that source version's digest before they reach the model. Dynamic outputs should be passed through brokered artifacts rather than unclassified file reads. |
| Baseline bypass | Production API admission and production model launch reject baseline execution. Automated tests retain isolated positive controls. Historical comparisons remain readable. A production baseline service requires a separate disposable worker design before re-enablement. |
| Shared workspace | One live workflow reserves the configured workspace. Contained or recovering runs retain the reservation; terminal runs release it. Restarted controllers consult persisted active runs. This sacrifices concurrent workflow execution until per-run workers exist. |
| Expired sessions | Tokens are checked against actual expiry, run access rejects expired rooms, and every room identity socket joins its revocation channel. Socket messages reauthenticate; expiry timers close sockets independently of the sweep. |
| Socket abuse | Per-actor connection limits, message limits, subscription limits, replay limits, and bounded synchronization buffers apply. Large replay gaps receive an authoritative snapshot. Browser WebSocket origins are checked explicitly. |
| Oversized inputs | Source HTTP responses are read incrementally and cancelled on overflow. File reads use bounded buffers and regular-file checks. Worker file operations use descriptor checks and no-follow flags where supported. |
| Artifact tampering | Blob reads verify the content-addressed digest. New blob files and directories request restrictive permissions; Windows deployments must also enforce suitable filesystem ACLs. |
| Side effects and recovery | Fresh exact approvals can be required on every operation, including reruns. Recovery does not undo completed external effects. Keep consequential external operations outside this MVP unless their effects have an explicit operational recovery plan. |

## Evidence and remaining scope

### Verification on 2026-10-10

- Full regression suite: 178 passed, seven integration tests skipped; 46 test files passed. API TypeScript checking and worker syntax checking passed.
- Production dependency audit: zero reported advisories after dependency migration and the HTTP override. Environment and Compose configuration validation passed.
- One isolated live legitimate-work case passed after the Windows path correction. A subsequent broader live evaluation passed prompt-injection and jailbreak cases but failed requested output correctness in other cases, then stopped when a required provider completion was missing. Recorded target hits and unsafe executed actions were zero. This is mixed evidence, not a clean live acceptance result.
- Private evaluation details are retained in the ignored `.runtime-experiments/security-live-report.jsonl` file, including failed attempts. That file is local evidence, not a production data fixture.
- Docker Desktop was launched and stale runtime socket directories were preserved under backup names. The engine remained unresponsive, so real Docker, deployed Postgres/API, and Neo4j verification is incomplete.

### Judge questions and accurate answers

| Question | Answer |
| --- | --- |
| Can injected text bypass policy or use another agent's permissions? | Controller-owned identity, capabilities, classification restrictions, exact approvals, and dispatch fences are checked outside the model. Regression tests cover forgery and adversarial tool calls. Live output reliability remains variable. |
| Can confidential content leak through the dashboard or model calls? | Non-public previews and quotations are suppressed; configured model disclosure and tool classification boundaries are checked before invocation. Accurate source labels and carefully selected recipients are necessary. |
| Can the baseline bypass security in production? | Production admission and launch reject baseline execution. Positive controls exist inside automated tests. |
| Can an expired room or an abusive socket retain access? | Actual expiry is checked during authorization; room sockets are revoked and bounded by connection, message, subscription, replay, and buffering limits. |
| Can path traversal, large input, or edited blobs escape checks? | Canonical path confinement covers Windows separators, reads are bounded, undeclared reads are denied, and blob digests are verified. |
| Does recovery reverse an external action? | Recovery replaces affected internal execution state. Consequential operations can require fresh exact approval; external effects need their own operational recovery plan. |
| Is the system ready for horizontal scaling or universally immune to injection? | The current controller requires one writer and one active shared workspace. Separate workers and distributed coordination are required for scaling; no universal model-behavior guarantee is supported. |
| Are all live services and model scenarios proven to pass? | No. Automated regression and dependency checks pass; the broader live evaluation has failures, and Docker-backed deployment verification remains incomplete. |

Production dependencies now use Drizzle ORM 0.45.2 or later and the maintained `@earendil-works/pi-coding-agent` 0.79.0 package. The HTTP dependency is overridden to Undici 8.10.2. The old Pi package name had no patched release for its credential-file and extension-install advisories; the maintained release also addresses project extension approval. See the [upstream migration advisory](https://github.com/advisories/GHSA-jfgx-wxx8-mp94). Recheck dependency advisories during deployment rather than treating a clean audit as permanent.

Native Windows worker paths retain their configured mount namespace and normalize path separators for file policy matching. Container POSIX paths remain in their configured namespace; single-star file grants cannot cross either path separator.

Automated tests exercise the real journal, broker, API, gateway, host worker, approvals, containment, and recovery. Their scripted model behavior is test data, not evidence of live-model resistance. Live provider and Docker/Neo4j integration checks require configured services; skipped checks are not passes. Historical observations are recorded in `LIVE_VALIDATION.md` and do not establish validation of a later code revision.

Prompt injection within permitted behavior, semantic hallucinations, incorrect classification, malicious operator configuration, DB/controller administrator compromise, and container escape remain outside a universal guarantee. Quote verification proves selected source matches, and provenance proves observed input delivery; neither proves general truth or hidden model causality. The controller still requires the documented single-writer deployment; its execution fences, reservations, and admission locks are process-local. Use separate workers and distributed coordination before horizontal scaling. Restrict worker ingress to the controller, configure TLS at the deployment boundary, and protect audit mounts and provider credentials.
