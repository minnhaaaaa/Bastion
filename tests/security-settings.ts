import type { ApiSecurity } from "../apps/api/src/security-config";
/** Automated-test budgets; production requires API_SECURITY_JSON. */
export const testApiSecurity: ApiSecurity = {
  requestsPerMinute: 10000, maxSocketsPerActor: 10, socketMessagesPerMinute: 1000,
  maxRunSubscriptions: 10, maxReplayEvents: 100, maxBufferedEvents: 100,
  maxConcurrentExpensiveRequests: 100, maxActiveRunsPerOwner: 100,
  maxWorkflowTasks: 100, maxWorkflowSources: 100, maxWorkflowRules: 1000,
};
export function testRuntimeSecurity(modelOrigins: string[]) {
  return JSON.stringify({ modelOrigins, modelClassifications: ["PUBLIC", "INTERNAL"],
    approvalOperations: [],
    operationClassifications: { "fs.read": ["PUBLIC", "INTERNAL"], "fs.write": ["PUBLIC", "INTERNAL"], "net.http": ["PUBLIC", "INTERNAL"], "proc.exec": ["PUBLIC", "INTERNAL"] },
    toolOutputClassifications: { "fs.read": "PUBLIC", "fs.write": "PUBLIC", "net.http": "PUBLIC", "proc.exec": "PUBLIC" },
  });
}
