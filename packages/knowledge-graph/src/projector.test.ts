import { describe, expect, it } from "vitest";
import { newId, applyEvent, RunEvent, type RunSnapshot } from "@bastion/contracts";
import { parseSchema, statementsFor } from "./projector";
import { readFileSync } from "node:fs";

const ev = (seq: number, runId: string, type: string, payload: unknown) =>
  RunEvent.parse({ eventId: newId("event"), runId, seq, timestamp: new Date().toISOString(), traceId: newId("trace"), type, payload });

describe("projector statements", () => {
  it("emits idempotent MERGEs for new nodes/edges and advances the cursor", () => {
    const runId = newId("run");
    const exec = newId("exec");
    const src = newId("source");
    const task = newId("task");
    const events = [
      ev(1, runId, "run.created", { projectId: newId("project"), workflowId: newId("workflow"), workflowVersion: 1, mode: "PROTECTED" }),
      ev(2, runId, "source.ingested", { sourceVersionId: src, name: "n", version: 1, contentHash: "h", trust: "UNTRUSTED", classification: "PUBLIC", blobRef: "b", preview: "" }),
      ev(3, runId, "task.state_changed", { taskId: task, executionId: exec, attempt: 1, from: "PENDING", to: "RUNNING" }),
      ev(4, runId, "artifact.consumed", { inputVersionId: src, consumerExecutionId: exec, consumerTaskId: task }),
    ];
    let s: RunSnapshot | null = null;
    let last: ReturnType<typeof statementsFor> = [];
    for (const e of events) {
      const next = applyEvent(s, e);
      last = statementsFor(s, next, e);
      s = next;
    }
    expect(last.some((x) => x.query.includes(":CONSUMED") && x.params.from === src && x.params.to === exec)).toBe(true);
    expect(last.every((x) => x.query.startsWith("MERGE"))).toBe(true);
    expect(last.at(-1)!.params).toMatchObject({ runId, seq: 4 });
  });

  it("parses schema.cypher into statements", () => {
    const stmts = parseSchema(readFileSync(new URL("../schema.cypher", import.meta.url), "utf8"));
    expect(stmts.length).toBeGreaterThan(5);
    expect(stmts.every((s) => s.startsWith("CREATE"))).toBe(true);
  });
});
