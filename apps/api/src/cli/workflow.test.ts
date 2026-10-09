import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, testWorkflowDefinition } from "../testing";
import { main } from "./workflow";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const capture = () => {
  const lines: string[] = [];
  return { lines, out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(`ERR ${s}`) } };
};

async function file(content: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "bastion-cli-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const p = join(dir, "wf.json");
  await writeFile(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}

describe("workflow CLI", () => {
  it("validates and reports readable errors", async () => {
    const good = capture();
    expect(await main(["validate", await file(testWorkflowDefinition())], {}, good.out)).toBe(0);
    expect(good.lines[0]).toMatch(/^valid:/);
    const bad = capture();
    const def = testWorkflowDefinition();
    def.tasks[0]!.agentId = "agent_missing";
    expect(await main(["validate", await file(def)], {}, bad.out)).toBe(1);
    expect(bad.lines.join("\n")).toMatch(/unknown agent/);
    expect(await main(["validate", await file("{not json")], {}, capture().out)).toBe(1);
  });

  it("creates a project, submits a workflow and a new version against a live server", async () => {
    const t = await createTestApp();
    cleanup.push(() => t.close());
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const env = { API_URL: `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`, OPERATOR_TOKEN: t.tokenA };
    const p = capture();
    expect(await main(["project", "cli"], env, p.out)).toBe(0);
    const projectId = /created project (\S+)/.exec(p.lines[0]!)![1]!;
    const path = await file(testWorkflowDefinition());
    const s = capture();
    expect(await main(["submit", path, "--project", projectId], env, s.out)).toBe(0);
    const [, wfId] = /registered (\S+) v1/.exec(s.lines[0]!)!;
    const v = capture();
    expect(await main(["submit", path, "--version-of", wfId!], env, v.out)).toBe(0);
    expect(v.lines[0]).toBe(`registered ${wfId} v2`);
    const noAuth = capture();
    expect(await main(["submit", path, "--project", projectId], { API_URL: env.API_URL }, noAuth.out)).toBe(1);
    expect(noAuth.lines[0]).toMatch(/OPERATOR_TOKEN is required/);
  });
});
