import { z } from "zod";
import * as Id from "./ids";
import { RunStatus } from "./enums";

/**
 * Evaluation metrics (PLAN §10), computed only from persisted events, the snapshot and the
 * sandbox's target-side audit. `null` means "not measurable here", never "zero".
 */
export const RunMetrics = z.object({
  runId: Id.RunId,
  mode: z.enum(["PROTECTED", "BASELINE"]),
  workflowId: Id.WorkflowId,
  workflowVersion: z.number().int(),
  status: RunStatus,
  toolCalls: z.object({
    requested: z.number().int(),
    allowed: z.number().int(),
    denied: z.number().int(),
    approvalRequired: z.number().int(),
    executed: z.number().int(),
    errored: z.number().int(),
  }),
  /** Forbidden operations that actually reached a sandbox target (worker access audit). */
  unsafeActionsExecuted: z.number().int().nullable(),
  /** Every task's latest execution SUCCEEDED and CLEAR. */
  legitimateCompletion: z.boolean(),
  tasks: z.object({ total: z.number().int(), succeeded: z.number().int(), failed: z.number().int() }),
  executions: z.object({ total: z.number().int(), reruns: z.number().int() }),
  incidents: z.object({ total: z.number().int(), resolved: z.number().int(), recoveryFailed: z.number().int() }),
  /** Per quarantined source: how much of its observed impact set was actually invalidated. */
  quarantineCoverage: z.array(
    z.object({
      sourceVersionId: Id.SourceVersionId,
      affectedExecutions: z.number().int(),
      invalidatedExecutions: z.number().int(),
      affectedArtifacts: z.number().int(),
      invalidatedArtifacts: z.number().int(),
      coverage: z.number().nullable(),
    }),
  ),
  /** Denials in executions with no untrusted ancestry — candidates for false blocks (needs human review). */
  deniedWithoutUntrustedInput: z.number().int(),
  timings: z.object({
    runMs: z.number().nullable(),
    /** incident.opened → containment.applied, per incident */
    containmentMs: z.array(z.number()),
    /** recovery.started → recovery.completed, per recovery */
    recoveryMs: z.array(z.number()),
  }),
  /** Content hashes of attack-installed source versions (source.modified). */
  attackContentHashes: z.array(z.string()),
  events: z.number().int(),
  graphProjectedUpTo: z.number().int(),
});
export type RunMetrics = z.infer<typeof RunMetrics>;

export const RunComparison = z.object({
  protected: RunMetrics,
  baseline: RunMetrics,
  /** Both runs pinned to the same workflow id + version. */
  sameWorkflowVersion: z.boolean(),
  /** Both runs received byte-identical attack content. */
  sameAttackContent: z.boolean(),
});
export type RunComparison = z.infer<typeof RunComparison>;
