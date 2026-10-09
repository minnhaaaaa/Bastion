import { execFile } from "node:child_process";
import { realpath, lstat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { SourceDefinition, PolicyRule, WorkflowDefinition, newId } from "@bastion/contracts";

const Permission = z.object({ operation: z.enum(["fs.read", "fs.write"]), decision: z.enum(["ALLOW", "REQUIRE_APPROVAL"]) }).strict();
export const RepositorySelection = z.object({ directory: z.string().trim().min(1), permissions: z.array(Permission).min(1) }).strict().superRefine((value, ctx) => {
  if (!value.permissions.some(p => p.operation === "fs.read" && p.decision === "ALLOW") || value.permissions.some(p => p.operation === "fs.read" && p.decision !== "ALLOW")) ctx.addIssue({ code: "custom", message: "Connecting sources requires explicit read access" });
  if (new Set(value.permissions.map(p => p.operation)).size !== value.permissions.length) ctx.addIssue({ code: "custom", message: "Duplicate permission" });
  if (value.permissions.some(p => p.operation === "fs.write" && p.decision !== "REQUIRE_APPROVAL")) ctx.addIssue({ code: "custom", message: "Repository edits require review" });
});
export const RepositoryAccess = z.object({ directory: z.string(), permissions: z.array(Permission), sources: z.array(SourceDefinition), policyRules: z.array(PolicyRule), connectedAt: z.string().datetime() });
export type RepositoryAccess = z.infer<typeof RepositoryAccess>;
export type RepositoryConnector = (selection: z.infer<typeof RepositorySelection>) => Promise<RepositoryAccess>;

/** Enumerates tracked regular files only. No checkout, hooks, filters, network or shell. */
export function repositoryConnector(config: { hostRoot: string; workerRoot: string; gitExecutable: string; timeoutMs: number; maxBytes: number; toolOperations: Record<string, string> }): RepositoryConnector {
  if (!isAbsolute(config.gitExecutable) || !Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0 || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("Invalid repository connector configuration");
  return async input => {
    const selection = RepositorySelection.parse(input);
    if (selection.permissions.some(p => !Object.values(config.toolOperations).includes(p.operation))) throw new Error("Selected file operation is unavailable");
    const root = await realpath(config.hostRoot);
    const confined = (path: string) => {
      const suffix = relative(root, path);
      if (suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) throw new Error("Repository escapes the sandbox");
      return suffix;
    };
    const rel = posix.isAbsolute(selection.directory) ? posix.relative(config.workerRoot, selection.directory) : selection.directory;
    const candidate = resolve(root, rel);
    confined(candidate);
    const directory = await realpath(candidate);
    const suffix = confined(directory);
    // Bound Git's output and execution; clear inherited Git configuration/environment overrides.
    const git = async (args: string[]) => (await promisify(execFile)(config.gitExecutable, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", directory, ...args], { env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, timeout: config.timeoutMs, maxBuffer: config.maxBytes, encoding: "utf8" })).stdout;
    const top = await realpath((await git(["rev-parse", "--show-toplevel"])).trim());
    if (top !== directory) throw new Error("Select the repository root");
    const files = (await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean);
    const sources: RepositoryAccess["sources"] = [];
    let totalBytes = 0;
    for (const file of [...new Set(files)]) {
      const path = resolve(directory, file);
      const within = relative(directory, path);
      if (within === ".." || within.startsWith("../") || isAbsolute(within)) throw new Error("Invalid tracked path");
      const stat = await lstat(path);
      // Symlinks and submodules require separate explicit connections.
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (await realpath(path) !== path) throw new Error("Tracked file traverses a symlink");
      totalBytes += stat.size;
      if (totalBytes > config.maxBytes) throw new Error("Repository exceeds the configured source budget");
      const location = posix.join(config.workerRoot, suffix.split("\\").join("/"), file);
      if (/[?*]/.test(location)) throw new Error("Tracked filenames cannot contain policy glob operators");
      // Repository text is untrusted input, never privileged instructions or public data.
      sources.push({ name: file, location, trust: "UNTRUSTED", classification: "INTERNAL" });
    }
    if (!sources.length) throw new Error("Repository contains no tracked regular files");
    return { directory: posix.join(config.workerRoot, suffix.split("\\").join("/")), permissions: selection.permissions, sources,
      policyRules: selection.permissions.flatMap(permission => sources.map(source => ({ id: newId("command"), description: `${permission.decision}: ${permission.operation} ${source.name}`, decision: permission.decision, operation: permission.operation, resourcePattern: source.location }))), connectedAt: new Date().toISOString() };
  };
}

/** Capabilities and policy are compiled exclusively from the operator's persisted selection. */
export function applyRepositoryAccess(definition: WorkflowDefinition, access: RepositoryAccess): WorkflowDefinition {
  return WorkflowDefinition.parse({ ...definition, sources: access.sources, policyRules: access.policyRules,
    agents: definition.agents.map(agent => ({ ...agent, capabilities: access.policyRules.map(rule => `${rule.operation}:${rule.resourcePattern}`) })),
    tasks: definition.tasks.map(task => ({ ...task, sourceNames: access.sources.map(source => source.name) })),
  });
}
