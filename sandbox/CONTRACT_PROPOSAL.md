# Member 2: B3/B4 contract proposal for acknowledgement

Status: proposed, not applied to `packages/contracts`. `AGENTS.md` and `TEAM_PLAN.md` require all three members' acknowledgement. The executors and tests use local interfaces until that happens. Do not present these proposed endpoints/events as available to the UI.

## B3: exact tool approval

Member 2 has implemented `ToolApprovalService`, its private durable-store interface, and the optional gateway pending-request hook. Existing callers without the hook continue to deny approval-gated calls. Concurrent approval, rejection, expiry, argument tampering, changed normalized targets, workflow-version changes, quarantined inputs and execution errors have automated coverage.

Proposed additive shared schemas:

- `ApproveToolCmd`: `commandId`, `approvalId`, `toolRequestId`, `actionDigest`, `decision: APPROVE | REJECT`. Human identity comes from authenticated server state, never the body.
- `ToolApprovalView`: `approvalId`, `runId`, `executionId`, `toolRequestId`, `actionDigest`, `expiresAt`, `status`, `operation`, redacted `resourcePreview`. Never return raw arguments, sources or tool output to arena players.
- `tool.approval_requested`: `approvalId`, `toolRequestId`, `actionDigest`, `expiresAt`, redacted resource preview. Keep this separate from recovery `approval.requested`, whose fields require an incident and recovery plan.
- `tool.approval_resolved`: `approvalId`, `toolRequestId`, `status`, `actorId` for an authorized human. Include rejected/expired/consumed transitions. Existing `tool.decided` and `tool.executed` retain the actual authorization and execution result.
- Add a separate `toolApprovals` collection to `RunSnapshot`, plus reducer and persistence handlers. Do not reuse recovery-plan approvals.

The action digest is a canonical SHA-256 of the approval ID, exact call (run/task/agent/execution/tool/trace and private arguments), normalized policy request (target, classification and consumed input versions), policy rule ID, pinned workflow ID/version and expiry. Key-order changes do not change the digest. Raw arguments live only in private server storage.

Member 3 should implement the `ToolApprovalStore` methods in Postgres and add a human-only, project-owned REST route, proposed as `POST /api/tool-approvals/:id/resolve`, behind command deduplication. `consume` is an atomic compare-and-set that checks status, digest and expiry against the server clock and records the actor. Single-use consumption occurs before the side effect. A crash or execution failure never re-enables the approval; it gives at-most-once execution, not a false guarantee of retryable exactly-once external effects.

The gateway returns the existing `PENDING_APPROVAL` result once durable creation succeeds. Pending calls must suspend Pi's tool result outside the execution fence, with an expiring waiter; approval resolution returns the result to that same runtime call. Hold/quarantine/timeout/restart must cancel the waiter. A run must not be marked succeeded while an approval remains pending. This waiter, new lifecycle events, database store and HTTP route must be wired together before enabling the optional gateway hook in production. The existing shared execution fence still covers final reauthorization through execution.

Before execution, the service checks human ownership, digest/expiry, the pinned version, active execution, protected mode, identical classification/input set, an unchanged normalized target, the same approval policy rule, and usability of every consumed input. It atomically consumes the approval, records ALLOW, executes, and records SUCCESS or ERROR. Rejected/expired/failed calls never execute or become reusable.

## B4: workflow-declared verification

Member 2 has implemented `verifySelectedClaims` and `verifyToolAcceptanceChecks`. The first emits the existing `claim.unverified` event after checking exact quotations in the output and trusted, usable sources linked by observed transitive provenance. It is quotation corroboration, not semantic truth detection. A required redactor supplies the public claim preview. The second runs checks through the gateway under a real active VERIFIER execution and treats denials/pending approvals as failed checks.

Proposed optional `WorkflowDefinition.acceptanceChecks` field, empty when absent:

- Exact-quote check: discriminant `kind: SOURCE_QUOTE`, a unique check `id`, output task/artifact logical name, selected output JSON pointer(s), and permitted cited source names.
- Tool check: discriminant `kind: TOOL`, unique `id`, verifier task ID, registered tool name, and arguments stored as workflow data. For `proc.exec`, require a configured executable and explicit argv; never accept a shell string or model-generated replacement command.

Validate unknown task/source/tool references, duplicate IDs, VERIFIER role, JSON pointer syntax and supported check kinds before storing a workflow. Pin check data to the workflow version. Exact-quote selection must be explicit; do not invent claims or give model outputs authority to choose their own acceptance tests.

Tool checks run during the named verifier task, before publication/settlement, so the execution is RUNNING and the gateway's authoritative ownership checks apply. Their results combine with the existing state/audit checks for normal completion and recovery. Running them after all tasks have succeeded would be blocked by the current gateway and must not be bypassed.

## Acknowledgements needed

Member 1: approve the additive UI-facing views/events and pending-tool presentation.

Member 2: implementation is prepared in this change; review the exact schema proposal above.

Member 3: approve schema/event additions, persistence/CAS semantics, the authenticated route and waiter/restart wiring. No API route or shared-schema migration is part of this proposal yet.
