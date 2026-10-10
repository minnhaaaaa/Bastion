import { expect, it } from "vitest";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";

it("the real worker rejects argument substitution before execution and bounds file reads", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bastion-worker-security-")));
  const root = join(directory, "workspace"); await mkdir(root);
  const audit = join(directory, crypto.randomUUID()); await writeFile(audit, "");
  const file = join(root, crypto.randomUUID()); await writeFile(file, "x".repeat(2049));
  const net = createServer(); await new Promise<void>(resolve => net.listen(0, "127.0.0.1", resolve));
  const port = (net.address() as { port: number }).port;
  await new Promise<void>(resolve => net.close(() => resolve()));
  const token = crypto.randomUUID(), output = crypto.randomUUID();
  const argv = ["-e", `process.stdout.write(${JSON.stringify(output)})`];
  const worker = fork(resolve("sandbox/worker.mjs"), [], { silent: true, env: { ...process.env,
    SANDBOX_ROOT: root, SANDBOX_AUDIT_PATH: audit, SANDBOX_TOKEN: token,
    SANDBOX_HTTP_ORIGINS: "[]", SANDBOX_EXEC_COMMANDS: JSON.stringify([{ executable: process.execPath, argv }]),
    SANDBOX_TIMEOUT_MS: "2000", SANDBOX_MAX_BYTES: "2048", SANDBOX_PORT: String(port), SANDBOX_BIND_HOST: "127.0.0.1",
  } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker startup timeout")), 5000);
      worker.once("message", () => { clearTimeout(timeout); resolve(); });
      worker.once("exit", () => { clearTimeout(timeout); reject(new Error("Worker exited")); });
    });
    const dispatch = (operation: string, resource: string, args: object) => fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, resource, args, executionId: crypto.randomUUID(), toolRequestId: crypto.randomUUID() }),
    });
    const substituted = ["-e", "process.exit(0)"];
    expect((await dispatch("proc.exec", JSON.stringify([process.execPath, ...substituted]), { executable: process.execPath, argv: substituted })).status).toBe(400);
    expect(await readFile(audit, "utf8")).toBe("");
    const allowed = await dispatch("proc.exec", JSON.stringify([process.execPath, ...argv]), { executable: process.execPath, argv });
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { output: { stdout: string } }).output.stdout).toBe(output);
    expect((await dispatch("fs.read", file, {})).status).toBe(400);
    expect((await dispatch("fs.read", join(root, "..", "outside"), {})).status).toBe(400);
  } finally {
    if (worker.exitCode === null) {
      const exit = new Promise<void>(resolve => worker.once("exit", () => resolve()));
      worker.kill(); await exit;
    }
    const suffix = relative(await realpath(tmpdir()), directory);
    if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) throw new Error("Unsafe test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
