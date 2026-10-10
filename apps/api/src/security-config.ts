import { z } from "zod";
import { Classification } from "@bastion/contracts";

const positive = z.number().int().positive();
export const ApiSecurity = z.object({
  requestsPerMinute: positive,
  maxSocketsPerActor: positive,
  socketMessagesPerMinute: positive,
  maxRunSubscriptions: positive,
  maxReplayEvents: positive,
  maxBufferedEvents: positive,
  maxConcurrentExpensiveRequests: positive,
  maxActiveRunsPerOwner: positive,
  maxWorkflowTasks: positive,
  maxWorkflowSources: positive,
  maxWorkflowRules: positive,
}).strict();
export type ApiSecurity = z.infer<typeof ApiSecurity>;

const origin = z.string().url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && url.origin === value;
}, "Expected an exact HTTP origin");
export const RuntimeSecurity = z.object({
  modelOrigins: z.array(origin).min(1),
  modelClassifications: z.array(Classification).min(1),
  operationClassifications: z.record(z.array(Classification)),
  toolOutputClassifications: z.record(Classification),
  approvalOperations: z.array(z.string().min(1)),
}).strict();
export type RuntimeSecurity = z.infer<typeof RuntimeSecurity>;

export function parseSecurityConfig<T>(schema: z.ZodType<T>, value: string | undefined, name: string): T {
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  try { return schema.parse(JSON.parse(value)); }
  catch { throw new Error(`Invalid ${name}`); }
}

export function assertModelBoundary(config: RuntimeSecurity, baseUrl: string, classifications: string[]) {
  const url = new URL(baseUrl);
  if (url.username || url.password || !config.modelOrigins.includes(url.origin)) throw new Error("Model destination is not approved");
  if (classifications.some(value => !config.modelClassifications.includes(Classification.parse(value)))) throw new Error("Input classification is not approved for model disclosure");
}
