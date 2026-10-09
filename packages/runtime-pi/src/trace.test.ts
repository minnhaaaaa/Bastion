import { it, expect } from "vitest";
import { mkdtemp, readFile, rm, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { newId } from "@bastion/contracts";
import { privatePiTraceWriter } from "./trace";

it("records actual private telemetry and refuses path traversal in execution IDs", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bastion-trace-")));
  try {
    const writer = privatePiTraceWriter(directory);
    const record = { at: new Date().toISOString(), runId: newId("run"), executionId: newId("exec"), sessionId: crypto.randomUUID(), kind: "prompt" as const, data: { text: crypto.randomUUID() } };
    await writer(record);
    expect(JSON.parse((await readFile(join(directory, record.executionId + ".jsonl"), "utf8")).trim())).toEqual(record);
    await expect(writer({ ...record, executionId: "../escape" })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([record.executionId + ".jsonl"]);
  } finally {
    const rel = relative(await realpath(tmpdir()), directory);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
