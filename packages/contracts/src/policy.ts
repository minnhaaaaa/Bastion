import { z } from "zod";
import * as Id from "./ids";
import { Classification, PolicyDecision } from "./enums";

/**
 * Capability grammar: `<domain>.<operation>:<resource-glob>`
 *   fs.read:/workspace/docs/**
 *   fs.write:/workspace/repo/**
 *   net.http:docs.fixture.internal
 *   proc.exec:pnpm test
 * Anything not granted is denied (default deny).
 */
export const Capability = z.string().regex(/^[a-z]+\.[a-z_]+:.+$/, "expected <domain>.<op>:<resource>");
export type Capability = z.infer<typeof Capability>;

export const CapabilityProfile = z.object({
  agentId: Id.AgentId,
  capabilities: z.array(Capability),
});
export type CapabilityProfile = z.infer<typeof CapabilityProfile>;

/** Normalized request built by the Tool Gateway before any dispatch (ARCHITECTURE §5.2). */
export const PolicyRequest = z.object({
  runId: Id.RunId,
  agentId: Id.AgentId,
  executionId: Id.ExecutionId,
  toolRequestId: Id.ToolRequestId,
  /** Tool name as exposed to the agent, e.g. "read_file", "http_request". */
  tool: z.string(),
  /** Normalized operation, e.g. "fs.read", "net.http", "proc.exec". */
  operation: z.string(),
  /** Normalized resource: absolute path, URL, or command. */
  resource: z.string(),
  destination: z.string().optional(),
  /** Highest classification among the inputs the calling task consumed. */
  inputClassification: Classification,
  /** Input artifact/source versions of the calling execution (re-checked for quarantine at dispatch). */
  inputVersionIds: z.array(z.string()),
});
export type PolicyRequest = z.infer<typeof PolicyRequest>;

export const PolicyResult = z.object({
  decision: PolicyDecision,
  /** Machine-readable rule ID, e.g. "fs.secrets.deny", "default.deny", "policy.unavailable". */
  ruleId: z.string(),
  reason: z.string(),
});
export type PolicyResult = z.infer<typeof PolicyResult>;

export const PolicyRule = z.object({
  id: z.string(),
  description: z.string(),
  decision: PolicyDecision,
  operation: z.string(),
  /** Glob over the normalized resource. */
  resourcePattern: z.string(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;
