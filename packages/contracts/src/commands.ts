import { z } from "zod";
import * as Id from "./ids";
import { WorkflowDefinition } from "./workflow";

/**
 * REST command bodies (ARCHITECTURE §8). Every mutation carries a client-generated
 * `commandId` used as the idempotency key: a replayed command returns the prior result.
 * Authorization (role, room membership, run phase) is decided server-side, never from the body.
 */
const cmd = <S extends z.ZodRawShape>(shape: S) => z.object({ commandId: Id.CommandId, ...shape });

// POST /api/workflows — register a workflow definition (stored in Postgres, versioned)
export const CreateWorkflowCmd = cmd({
  projectId: Id.ProjectId,
  definition: WorkflowDefinition,
});
export type CreateWorkflowCmd = z.infer<typeof CreateWorkflowCmd>;

// POST /api/runs
export const CreateRunCmd = cmd({
  workflowId: Id.WorkflowId,
  mode: z.enum(["PROTECTED", "BASELINE"]),
});
export type CreateRunCmd = z.infer<typeof CreateRunCmd>;

// POST /api/incidents/:id/quarantine
export const QuarantineCmd = cmd({
  sourceVersionId: Id.SourceVersionId,
});
export type QuarantineCmd = z.infer<typeof QuarantineCmd>;

// POST /api/incidents/:id/recovery-plan
export const RecoveryPlanCmd = cmd({
  replacementSourceVersionId: Id.SourceVersionId,
});
export type RecoveryPlanCmd = z.infer<typeof RecoveryPlanCmd>;

// POST /api/incidents/:id/approve-recovery
export const ApproveRecoveryCmd = cmd({
  approvalId: Id.ApprovalId,
  planId: Id.PlanId,
  /** Must equal the plan digest the approver was shown. */
  actionDigest: z.string(),
  decision: z.enum(["APPROVE", "REJECT"]),
});
export type ApproveRecoveryCmd = z.infer<typeof ApproveRecoveryCmd>;

// POST /api/arena/rooms
export const CreateRoomCmd = cmd({
  workflowId: Id.WorkflowId,
});
export type CreateRoomCmd = z.infer<typeof CreateRoomCmd>;

// POST /api/arena/rooms/:id/join
export const JoinRoomCmd = cmd({
  joinCode: z.string().min(4).max(12),
  displayAlias: z.string().min(1).max(24),
});
export type JoinRoomCmd = z.infer<typeof JoinRoomCmd>;

export const JoinRoomResult = z.object({
  playerId: Id.PlayerId,
  /** Bearer token for this player's REST calls and socket room.subscribe. Never shared. */
  playerToken: z.string(),
});
export type JoinRoomResult = z.infer<typeof JoinRoomResult>;

// POST /api/arena/rooms/:id/start  (host only)
export const StartRoundCmd = cmd({});
export type StartRoundCmd = z.infer<typeof StartRoundCmd>;

// POST /api/arena/rooms/:id/reveal (host only)
export const RevealCmd = cmd({});
export type RevealCmd = z.infer<typeof RevealCmd>;

// POST /api/arena/rooms/:id/actions
// Typed game actions. No free-form text, URLs or shell commands are accepted.
export const ArenaActionCmd = z.discriminatedUnion("card", [
  cmd({
    card: z.literal("POISON_DOCUMENT"),
    /** id of an entry in the run's workflow `attackPayloads` (stored server-side), never free text. */
    attackPayloadId: z.string(),
  }),
  cmd({ card: z.literal("REDIRECT_TOOL"), attackPayloadId: z.string() }),
  cmd({ card: z.literal("LEAK_SECRET"), attackPayloadId: z.string() }),
  cmd({ card: z.literal("INSPECT_SOURCE"), sourceVersionId: Id.SourceVersionId }),
  cmd({ card: z.literal("TRACE_DEPENDENCY"), fromId: z.string() }),
  cmd({ card: z.literal("REVIEW_TOOL_DECISION"), toolRequestId: Id.ToolRequestId }),
  cmd({ card: z.literal("QUARANTINE"), incidentId: Id.IncidentId, sourceVersionId: Id.SourceVersionId }),
  cmd({
    card: z.literal("APPROVE_RECOVERY"),
    incidentId: Id.IncidentId,
    approvalId: Id.ApprovalId,
    planId: Id.PlanId,
    actionDigest: z.string(),
  }),
  cmd({ card: z.literal("SHARE_EVIDENCE"), evidenceId: z.string() }),
]);
export type ArenaActionCmd = z.infer<typeof ArenaActionCmd>;

/** Standard error body for all 4xx/5xx responses. */
export const ApiError = z.object({
  error: z.object({
    code: z.enum([
      "VALIDATION",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "EXPIRED",
      "WRONG_PHASE",
      "INTERNAL",
    ]),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
