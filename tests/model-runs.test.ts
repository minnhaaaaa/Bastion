import { it, expect } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

it("model experiment tool pairs pinned runs, paginates real responses and records observed variance", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bastion-experiment-")));
  const workflowId = "wf_" + crypto.randomUUID().replaceAll("-", ""); const token = crypto.randomUUID();
  const runs = new Map<string, { mode: string; commandId: string }>();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url!, "http://test.invalid");
    if (url.pathname === `/api/workflows/${workflowId}`) { res.end(JSON.stringify({ id: workflowId, version: 1 })); return; }
    if (url.pathname === "/api/runs" && req.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const runId = "run_" + crypto.randomUUID().replaceAll("-", ""); runs.set(runId, data);
      res.end(JSON.stringify({ runId })); return;
    }
    const runId = url.pathname.split("/")[3]!; const run = runs.get(runId);
    if (!run) { res.writeHead(404).end(); return; }
    if (url.pathname.endsWith("/events")) {
      const after = Number(url.searchParams.get("after")); const limit = Number(url.searchParams.get("limit"));
      res.end(JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ seq: i + 1, runId })).filter(e => e.seq > after).slice(0, limit))); return;
    }
    res.end(JSON.stringify({ run: { id: runId, workflowVersion: 1, status: "COMPLETED", mode: run.mode }, lastSeq: 3, toolRequests: {}, verification: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const output = join(directory, "experiments.jsonl");
    const port = (server.address() as { port: number }).port;
    await promisify(execFile)(process.execPath, [resolve("sandbox/model-runs.mjs")], { env: { ...process.env, API_URL: `http://127.0.0.1:${port}`, OPERATOR_TOKEN: token, EXPERIMENT_WORKFLOW_ID: workflowId, EXPERIMENT_REPETITIONS: "2", EXPERIMENT_TIMEOUT_MS: "5000", EXPERIMENT_POLL_MS: "5", EXPERIMENT_EVENT_PAGE_SIZE: "2", EXPERIMENT_OUTPUT_PATH: output } });
    const records = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(runs.size).toBe(4);
    expect(new Set([...runs.values()].map(run => run.commandId)).size).toBe(4);
    expect(records.slice(0, 4).map(record => record.mode)).toEqual(["PROTECTED", "BASELINE", "PROTECTED", "BASELINE"]);
    expect(records.slice(0, 4).every(record => record.events.length === 3 && record.elapsedMs >= 0)).toBe(true);
    expect(records[4].summary.PROTECTED.count).toBe(2);
    expect(records[4].summary.BASELINE.populationStdDevMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(records)).not.toContain(token);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const rel = relative(await realpath(tmpdir()), directory);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
