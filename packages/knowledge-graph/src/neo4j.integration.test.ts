/**
 * Runs only against a real Neo4j: set NEO4J_TEST_URI, NEO4J_TEST_USER, NEO4J_TEST_PASSWORD.
 * Verifies the projection is idempotent and that impactSet agrees with the authoritative closure.
 */
import { describe, expect, it } from "vitest";
import { newId, type NewRunEvent } from "@bastion/contracts";
import { PgEventJournal } from "@bastion/db";
import { createTestDb, seedRun, setTaskState } from "@bastion/db/testing";
import { computeImpact } from "@bastion/recovery";
import { Neo4jProjector } from "./projector";
import { loadSchemaStatements } from "./index";

const uri = process.env.NEO4J_TEST_URI;

describe.skipIf(!uri)("Neo4jProjector (live Neo4j)", () => {
  it("projects idempotently and impactSet matches the Postgres closure", async () => {
    const { db, close } = await createTestDb();
    const journal = new PgEventJournal(db);
    const driver = Neo4jProjector.connect(uri!, process.env.NEO4J_TEST_USER!, process.env.NEO4J_TEST_PASSWORD!);
    const projector = new Neo4jProjector(driver, journal);
    try {
      await projector.start(await loadSchemaStatements());
      const { runId, traceId, taskIds } = await seedRun(db, journal, { a: [], b: ["a"], c: [] });
      const src = newId("source");
      const [ea, eb] = [newId("exec"), newId("exec")];
      const art = newId("artifact");
      await journal.append(runId, [
        { runId, traceId, type: "source.ingested", payload: { sourceVersionId: src, name: "n", version: 1, contentHash: "h", trust: "UNTRUSTED", classification: "PUBLIC", blobRef: "b", preview: "" } },
      ] as NewRunEvent[]);
      await setTaskState(journal, runId, taskIds.a!, ea, 1, "PENDING", "RUNNING");
      await journal.append(runId, [
        { runId, traceId, type: "artifact.consumed", payload: { inputVersionId: src, consumerExecutionId: ea, consumerTaskId: taskIds.a } },
        { runId, traceId, type: "artifact.published", payload: { artifactVersionId: art, name: "x", version: 1, contentHash: "h", producerExecutionId: ea, producerTaskId: taskIds.a, sourceIds: [src], derivedFrom: [], classification: "PUBLIC", trustState: "CLEAR", blobRef: "b", preview: "" } },
      ] as NewRunEvent[]);
      await setTaskState(journal, runId, taskIds.b!, eb, 1, "PENDING", "RUNNING");
      await journal.append(runId, [
        { runId, traceId, type: "artifact.consumed", payload: { inputVersionId: art, consumerExecutionId: eb, consumerTaskId: taskIds.b } },
      ] as NewRunEvent[]);

      const s = (await journal.snapshot(runId))!;
      const until = Date.now() + 5000;
      while ((await projector.projectedUpTo(runId)) < s.lastSeq && Date.now() < until) await new Promise((r) => setTimeout(r, 50));

      // Re-applying already projected events is a no-op.
      for (const e of await journal.read(runId)) await projector.apply(e);

      const g = await projector.impactSet(runId, src);
      const pg = computeImpact((await journal.snapshot(runId))!, src);
      expect(new Set(g.taskIds)).toEqual(new Set(pg.executionIds.map((id) => s.executions[id]!.taskId)));
      expect(new Set(g.artifactIds)).toEqual(new Set(pg.artifactIds));
    } finally {
      await projector.stop();
      await close();
    }
  });
});
