import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type WorkflowDefinition } from "@bastion/contracts";
import { PgEventJournal, RunRepository } from "@bastion/db";
import { createTestDb, seedRun, setTaskState } from "@bastion/db/testing";
import { FsBlobStore, PgArtifactBroker } from "@bastion/provenance";
import { acceptanceChecks } from "./verification";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(output: string) {
  const { db, close } = await createTestDb();
  const dir = await mkdtemp(join(tmpdir(), "bastion-acc-"));
  cleanups.push(close, () => rm(dir, { recursive: true, force: true }));
  const journal = new PgEventJournal(db);
  const broker = new PgArtifactBroker(journal, new RunRepository(db), new FsBlobStore(dir));
  const { runId, traceId, taskIds } = await seedRun(db, journal, { a: [] });
  const quote = `quote-${newId("trace")}`;
  const src = await broker.ingestSource({ runId, name: "manual", content: `preamble ${quote} trailer`, trust: "TRUSTED", classification: "PUBLIC", traceId });
  const ex = newId("exec");
  await setTaskState(journal, runId, taskIds.a!, ex, 1, "PENDING", "RUNNING");
  await broker.consume({ runId, inputVersionId: src.id, consumerExecutionId: ex, consumerTaskId: taskIds.a!, traceId });
  await broker.publish({ runId, name: "answer", producerExecutionId: ex, producerTaskId: taskIds.a!, content: output.replace("$QUOTE", quote), classification: "PUBLIC", traceId });
  await setTaskState(journal, runId, taskIds.a!, ex, 1, "RUNNING", "SUCCEEDED");
  const def = (checks: WorkflowDefinition["acceptanceChecks"]) => ({ name: "t", agents: [], sources: [], tasks: [], policyRules: [], attackPayloads: [], acceptanceChecks: checks }) as unknown as WorkflowDefinition;
  const run = async (checks: WorkflowDefinition["acceptanceChecks"]) =>
    acceptanceChecks((await journal.snapshot(runId))!, { definition: def(checks), journal, content: (r, v) => broker.content(r, v) });
  return { run, journal, runId, taskId: taskIds.a!, quote };
}

describe("workflow-declared acceptance checks", () => {
  it("SOURCE_QUOTE passes for quotes found in observed trusted sources and flags unsupported ones", async () => {
    const t = await setup(JSON.stringify({ cite: "$QUOTE", made_up: "this text appears in no source at all" }));
    const ok = await t.run([{ kind: "SOURCE_QUOTE", id: "c1", taskId: t.taskId, pointers: ["/cite"], sourceNames: ["manual"] }]);
    expect(ok).toEqual([{ name: "acceptance.source_quote:c1", passed: true, detail: "1/1 quotes supported" }]);

    const bad = await t.run([{ kind: "SOURCE_QUOTE", id: "c2", taskId: t.taskId, pointers: ["/cite", "/made_up"], sourceNames: ["manual"] }]);
    expect(bad[0]).toMatchObject({ passed: false, detail: "1/2 quotes supported" });
    const flagged = (await t.journal.read(t.runId)).filter((e) => e.type === "claim.unverified");
    expect(flagged).toHaveLength(1);
  });

  it("fails closed: non-JSON output, missing pointer, uncited source, and TOOL checks not run here", async () => {
    const t = await setup("not json");
    const [nonJson] = await t.run([{ kind: "SOURCE_QUOTE", id: "x", taskId: t.taskId, pointers: [""], sourceNames: ["manual"] }]);
    expect(nonJson).toMatchObject({ passed: false, detail: "task output is not JSON" });

    const j = await setup(JSON.stringify({ cite: "$QUOTE" }));
    const res = await j.run([
      { kind: "SOURCE_QUOTE", id: "missing", taskId: j.taskId, pointers: ["/nope"], sourceNames: ["manual"] },
      { kind: "SOURCE_QUOTE", id: "uncited", taskId: j.taskId, pointers: ["/cite"], sourceNames: ["other"] },
      { kind: "TOOL", id: "tests", taskId: j.taskId, tool: "run", args: {} },
    ]);
    expect(res.map((r) => r.passed)).toEqual([false, false, false]);
  });
});
