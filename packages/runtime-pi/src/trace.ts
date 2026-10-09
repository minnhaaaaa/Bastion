import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
export type PiTraceRecord = { at: string; runId: string; executionId: string; sessionId: string; kind: "prompt" | "tool" | "completed"; data: unknown };
/** Private traces may contain source content/secrets. Never broadcast or serve this directory. */
export function privatePiTraceWriter(directory: string): (record: PiTraceRecord) => Promise<void> {
  if (!directory.trim()) throw new Error("Private trace directory is required");
  return async record => {
    if (!/^exec_[a-zA-Z0-9]+$/.test(record.executionId)) throw new Error("Invalid execution ID");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, record.executionId + ".jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
  };
}
