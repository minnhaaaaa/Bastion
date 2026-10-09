import { expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { newId } from "@bastion/contracts";
import { SandboxClient, sandboxConfigFromEnv } from "./sandbox";

it("normalizes canonical paths, rejects traversal and strips URL credentials/redirect affordances", async () => {
  const tempRoot = tmpdir();
  const directory = await mkdtemp(join(tempRoot, "bastion-normalize-"));
  try {
    const name = crypto.randomUUID(); await writeFile(join(directory, name), crypto.randomUUID());
    const client = new SandboxClient({ url: "http://127.0.0.1:1", token: crypto.randomUUID(), hostRoot: directory, workerRoot: "/workspace", timeoutMs: 1000, toolOperations: { file: "fs.read", http: "net.http", exec: "proc.exec" } });
    const base = { runId: newId("run"), taskId: newId("task"), agentId: newId("agent"), executionId: newId("exec"), traceId: newId("trace") };
    expect(await client.normalize({ ...base, tool: "file", args: { path: name } })).toEqual({ operation: "fs.read", resource: `/workspace/${name}` });
    await expect(client.normalize({ ...base, tool: "file", args: { path: "../outside" } })).rejects.toThrow("escapes");
    await expect(client.normalize({ ...base, tool: "http", args: { url: "http://user:password@example.test" } })).rejects.toThrow();
    await expect(client.normalize({ ...base, tool: "unknown", args: {} })).rejects.toThrow();
    expect(await client.normalize({ ...base, tool: "http", args: { url: "https://EXAMPLE.test/a#fragment" } })).toEqual({ operation: "net.http", resource: "https://example.test/a", destination: "https://example.test" });
    const one = await client.normalize({ ...base, tool: "exec", args: { executable: "/bin/test", argv: ["a b"] } });
    const two = await client.normalize({ ...base, tool: "exec", args: { executable: "/bin/test", argv: ["a", "b"] } });
    expect(one.resource).not.toBe(two.resource);
  } finally {
    const rel = relative(await realpath(tempRoot), await realpath(directory));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

it("requires sandbox configuration without fallback hosts or credentials", () => { expect(() => sandboxConfigFromEnv({})).toThrow(); });
