import { expect, it, vi } from "vitest";
import { injectionReportingTool } from "./security-report";
import { newId } from "@bastion/contracts";

it("returns success only after the controller persists a report, and rejects aborted or failed reports", async () => {
  const receipt = { incidentId: newId("incident"), sourceVersionId: newId("source"), state: "OPEN" };
  const report = vi.fn(async () => receipt);
  const tool = injectionReportingTool(report);
  const context = {} as Parameters<typeof tool.execute>[4];
  const finding = { sourceVersionId: receipt.sourceVersionId, evidence: crypto.randomUUID(), reason: crypto.randomUUID(), severity: "HIGH" as const };
  const result = await tool.execute(crypto.randomUUID(), finding, undefined, undefined, context);
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ recorded: true, ...receipt }) }]);
  expect(report).toHaveBeenCalledWith(finding);
  const controller = new AbortController(); controller.abort();
  await expect(tool.execute(crypto.randomUUID(), finding, controller.signal, undefined, context)).rejects.toThrow("Execution stopped");
  expect(report).toHaveBeenCalledTimes(1);
  report.mockRejectedValueOnce(new Error("Persistence failed"));
  await expect(tool.execute(crypto.randomUUID(), finding, undefined, undefined, context)).rejects.toThrow("Persistence failed");
});
