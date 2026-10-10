import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@bastion/contracts";
import { PgEventJournal, RunRepository, type Db } from "@bastion/db";
import { createTestDb, seedRun, setTaskState } from "@bastion/db/testing";
import { FsBlobStore } from "./blobs";
import { PgArtifactBroker, UnusableInputError } from "./broker";
import { redactPreview } from "./redact";

let db: Db, close: () => Promise<void>, dir: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  dir = await mkdtemp(join(tmpdir(), "bastion-blobs-"));
});
afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe("PgArtifactBroker", () => {
  it("withholds inherited sensitive output and detects tampered blob contents", async () => {
    const journal = new PgEventJournal(db);
    const blobs = new FsBlobStore(dir);
    const broker = new PgArtifactBroker(journal, new RunRepository(db), blobs);
    const { runId, traceId, taskIds } = await seedRun(db, journal, { a: [] });
    const source = await broker.ingestSource({ runId, traceId, name: crypto.randomUUID(), content: crypto.randomUUID(), trust: "UNTRUSTED", classification: "INTERNAL" });
    const execution = newId("exec");
    await setTaskState(journal, runId, taskIds.a!, execution, 1, "PENDING", "RUNNING");
    await broker.consume({ runId, traceId, inputVersionId: source.id, consumerExecutionId: execution, consumerTaskId: taskIds.a! });
    const output = await broker.publish({ runId, traceId, name: crypto.randomUUID(), content: "short sensitive value", classification: "PUBLIC", producerExecutionId: execution, producerTaskId: taskIds.a! });
    expect(output).toMatchObject({ classification: "INTERNAL", preview: "" });
    await writeFile(join(dir, output.blobRef.split(":").at(-1)!), crypto.randomUUID());
    await expect(broker.content(runId, output.id)).rejects.toThrow("integrity");
  });
  it("records observed provenance through ingest → consume → publish", async () => {
    const journal = new PgEventJournal(db);
    const broker = new PgArtifactBroker(journal, new RunRepository(db), new FsBlobStore(dir));
    const { runId, traceId, taskIds } = await seedRun(db, journal, { a: [], b: ["a"] });
    const src = await broker.ingestSource({ runId, name: "doc", content: "hello docs", trust: "UNTRUSTED", classification: "PUBLIC", traceId });

    const ea = newId("exec");
    await setTaskState(journal, runId, taskIds.a!, ea, 1, "PENDING", "RUNNING");
    const got = await broker.consume({ runId, inputVersionId: src.id, consumerExecutionId: ea, consumerTaskId: taskIds.a!, traceId });
    expect(new TextDecoder().decode(got.content as Uint8Array)).toBe("hello docs");
    const artA = await broker.publish({ runId, name: "notes", producerExecutionId: ea, producerTaskId: taskIds.a!, content: "notes", classification: "PUBLIC", traceId });
    expect(artA.sourceIds).toEqual([src.id]);

    const eb = newId("exec");
    await setTaskState(journal, runId, taskIds.b!, eb, 1, "PENDING", "RUNNING");
    await broker.consume({ runId, inputVersionId: artA.id, consumerExecutionId: eb, consumerTaskId: taskIds.b!, traceId });
    const artB = await broker.publish({ runId, name: "patch", producerExecutionId: eb, producerTaskId: taskIds.b!, content: "patch", classification: "INTERNAL", traceId });
    expect(artB.sourceIds).toEqual([src.id]); // transitive origin
    expect(artB.classification).toBe("INTERNAL");

    const s = (await journal.snapshot(runId))!;
    const rel = (from: string, to: string) => s.edges.filter((e) => e.fromId === from && e.toId === to).map((e) => e.relation);
    expect(rel(src.id, ea)).toEqual(["CONSUMED"]);
    expect(rel(ea, artA.id)).toEqual(["PRODUCED"]);
    expect(rel(artA.id, eb)).toEqual(["CONSUMED"]);
    expect(rel(artA.id, artB.id)).toEqual(["DERIVED_FROM"]);
  });

  it("refuses to hand out quarantined inputs", async () => {
    const journal = new PgEventJournal(db);
    const broker = new PgArtifactBroker(journal, new RunRepository(db), new FsBlobStore(dir));
    const { runId, traceId, taskIds } = await seedRun(db, journal, { a: [] });
    const src = await broker.ingestSource({ runId, name: "doc", content: "x", trust: "UNTRUSTED", classification: "PUBLIC", traceId });
    expect(await broker.isUsable(src.id)).toBe(true);
    await broker.setTrust(src.id, "QUARANTINED");
    expect(await broker.isUsable(src.id)).toBe(false);
    const ea = newId("exec");
    await setTaskState(journal, runId, taskIds.a!, ea, 1, "PENDING", "RUNNING");
    await expect(broker.consume({ runId, inputVersionId: src.id, consumerExecutionId: ea, consumerTaskId: taskIds.a!, traceId })).rejects.toBeInstanceOf(UnusableInputError);
  });

  it("new content for the same source name becomes a new version (source.modified)", async () => {
    const journal = new PgEventJournal(db);
    const broker = new PgArtifactBroker(journal, new RunRepository(db), new FsBlobStore(dir));
    const { runId, traceId } = await seedRun(db, journal, { a: [] });
    const v1 = await broker.ingestSource({ runId, name: "doc", content: "v1", trust: "UNTRUSTED", classification: "PUBLIC", traceId });
    const v2 = await broker.ingestSource({ runId, name: "doc", content: "v2", trust: "UNTRUSTED", classification: "PUBLIC", traceId });
    expect(v2.version).toBe(2);
    expect((await broker.latestUsableSource(runId, "doc"))?.id).toBe(v2.id);
    const types = (await journal.read(runId)).map((e) => e.type);
    expect(types.filter((t) => t.startsWith("source."))).toEqual(["source.ingested", "source.modified"]);
    expect(v1.id).not.toBe(v2.id);
  });
});

describe("redactPreview", () => {
  it("removes secret-looking values and truncates", () => {
    const p = redactPreview(`api_key=sk_live_abcdef1234567890 and https://u:p@host/x ${"y".repeat(300)}`);
    expect(p).not.toContain("sk_live");
    expect(p).not.toContain("u:p@");
    expect(p.length).toBeLessThanOrEqual(200);
  });
});
