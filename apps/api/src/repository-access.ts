import { execFile } from "node:child_process";
import { realpath, lstat, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { SourceDefinition, PolicyRule, WorkflowDefinition, newId } from "@bastion/contracts";

const Permission = z.object({ operation: z.enum(["fs.read", "fs.write"]), decision: z.enum(["ALLOW", "REQUIRE_APPROVAL"]) }).strict();
export const RepositorySelection = z.object({ directory: z.string().trim().min(1), permissions: z.array(Permission).min(1) }).strict().superRefine((value, ctx) => {
  if (!value.permissions.some(p => p.operation === "fs.read" && p.decision === "ALLOW") || value.permissions.some(p => p.operation === "fs.read" && p.decision !== "ALLOW")) ctx.addIssue({ code: "custom", message: "Connecting sources requires explicit read access" });
  if (new Set(value.permissions.map(p => p.operation)).size !== value.permissions.length) ctx.addIssue({ code: "custom", message: "Duplicate permission" });
  if (value.permissions.some(p => p.operation === "fs.write" && p.decision !== "REQUIRE_APPROVAL")) ctx.addIssue({ code: "custom", message: "Repository edits require review" });
});
export const RepositoryAccess = z.object({ directory: z.string(), permissions: z.array(Permission), sources: z.array(SourceDefinition), policyRules: z.array(PolicyRule), connectedAt: z.string().datetime(), remoteUrl: z.string().url().optional(), revision: z.string().optional() });
export type RepositoryAccess = z.infer<typeof RepositoryAccess>;
export type RepositoryConnector = (selection: z.infer<typeof RepositorySelection>) => Promise<RepositoryAccess>;

/** Only these fixed, operator-facing messages may pass through the API. */
export class RepositoryConnectionError extends Error {}

/** Local enumeration and explicitly configured public HTTPS imports. Never runs repository scripts. */
export function repositoryConnector(config: { hostRoot: string; workerRoot: string; gitExecutable: string; timeoutMs: number; maxBytes: number; toolOperations: Record<string, string>; remoteOrigins?: string[]; cloneTimeoutMs?: number }): RepositoryConnector {
  if (!isAbsolute(config.gitExecutable) || !Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0 || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("Invalid repository connector configuration");
  for (const origin of config.remoteOrigins ?? []) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Invalid repository origin configuration");
  }
  if (config.remoteOrigins?.length && (!Number.isSafeInteger(config.cloneTimeoutMs) || config.cloneTimeoutMs! <= 0)) throw new Error("Invalid repository clone timeout");
  const connect: RepositoryConnector = async input => {
    const selection = RepositorySelection.parse(input);
    if (selection.permissions.some(p => !Object.values(config.toolOperations).includes(p.operation))) throw new RepositoryConnectionError("The controller does not support the selected file access. Ask the operator to enable the required read/write tools.");
    if (/^[a-z][a-z0-9+.-]*:/i.test(selection.directory) || /^git@/i.test(selection.directory)) {
      if (!config.remoteOrigins?.length) throw new RepositoryConnectionError("Public repository URL imports are not enabled on this controller. Use a local sandbox path or ask the operator to configure allowed repository origins.");
      let url: URL;
      try { url = new URL(selection.directory); }
      catch { throw new RepositoryConnectionError("Enter a public HTTPS repository URL."); }
      if (url.protocol !== "https:" || !config.remoteOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname) || url.pathname.split("/").some(part => part === "." || part === "..")) {
        throw new RepositoryConnectionError("Enter a public repository root URL on an allowed HTTPS host, without credentials, query parameters, or branch/file paths.");
      }
      const remoteUrl = url.href;
      const root = await realpath(config.hostRoot);
      const checkout = await mkdtemp(join(root, "repository-"));
      try {
        // Empty template, isolated config/environment, HTTPS only, no redirects, credentials,
        // submodule recursion or inherited filters. Git never evaluates a shell command here.
        try {
          await promisify(execFile)(config.gitExecutable, [
            "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
            "-c", "http.followRedirects=false", "clone", "--template=", "--depth=1",
            "--single-branch", "--no-tags", "--no-recurse-submodules", "--", remoteUrl, checkout,
          ], { env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
            timeout: config.cloneTimeoutMs, maxBuffer: config.maxBytes, encoding: "utf8" });
        } catch {
          throw new RepositoryConnectionError("The public repository could not be cloned within the configured limits. Check the URL and controller network access. Private repositories require authentication and are not supported by this connection.");
        }
        const access = await connect({ ...selection, directory: checkout });
        return { ...access, remoteUrl };
      } catch (error) {
        // Only remove the fresh directory created by this attempt, never a user's existing checkout.
        await rm(checkout, { recursive: true, force: true });
        throw error;
      }
    }
    const root = await realpath(config.hostRoot);
    const confined = (path: string) => {
      const suffix = relative(root, path);
      if (suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) throw new RepositoryConnectionError("The repository path is outside the sandbox workspace. Clone or move it into that workspace first.");
      return suffix;
    };
    // Accept either mounted worker paths or host paths inside the configured workspace.
    const hostSuffix = relative(root, resolve(selection.directory));
    const isHostPath = isAbsolute(selection.directory) && hostSuffix !== ".." && !hostSuffix.startsWith("../") && !isAbsolute(hostSuffix);
    const rel = posix.isAbsolute(selection.directory) ? posix.relative(config.workerRoot, selection.directory) : selection.directory;
    const candidate = isHostPath ? resolve(selection.directory) : resolve(root, rel);
    confined(candidate);
    let directory: string;
    try { directory = await realpath(candidate); }
    catch { throw new RepositoryConnectionError("That folder does not exist or cannot be read in the sandbox workspace. Clone the repository there and check the folder path."); }
    const suffix = confined(directory);
    // Bound Git's output and execution; clear inherited Git configuration/environment overrides.
    const git = async (args: string[]) => (await promisify(execFile)(config.gitExecutable, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", directory, ...args], { env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, timeout: config.timeoutMs, maxBuffer: config.maxBytes, encoding: "utf8" })).stdout;
    let top: string;
    try { top = await realpath((await git(["rev-parse", "--show-toplevel"])).trim()); }
    catch { throw new RepositoryConnectionError("Git could not read this folder as a working repository. Check that it is cloned and that the controller can access its Git metadata."); }
    if (top !== directory) throw new RepositoryConnectionError("Select the repository root folder, not a subfolder.");
    let files: string[];
    try { files = (await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean); }
    catch { throw new RepositoryConnectionError("Git could not list tracked files within the configured time or output limit. Check repository access and controller limits."); }
    const sources: RepositoryAccess["sources"] = [];
    let totalBytes = 0;
    for (const file of [...new Set(files)]) {
      const path = resolve(directory, file);
      const within = relative(directory, path);
      if (within === ".." || within.startsWith("../") || isAbsolute(within)) throw new RepositoryConnectionError("A tracked path escapes the repository.");
      let stat;
      try { stat = await lstat(path); }
      catch { throw new RepositoryConnectionError("A tracked file is missing or unreadable. Restore it or update the Git index before connecting."); }
      // Symlinks and submodules require separate explicit connections.
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (await realpath(path) !== path) throw new RepositoryConnectionError("A tracked file passes through a symbolic link. Connect regular files inside the repository.");
      totalBytes += stat.size;
      if (totalBytes > config.maxBytes) throw new RepositoryConnectionError("The tracked files exceed the configured source-size budget. Use a smaller repository or increase the controller source budget.");
      const location = posix.join(config.workerRoot, suffix.split("\\").join("/"), file);
      if (/[?*]/.test(location)) throw new RepositoryConnectionError("Tracked filenames contain unsupported wildcard characters. Rename them before connecting.");
      // Repository text is untrusted input, never privileged instructions or public data.
      sources.push({ name: file, location, trust: "UNTRUSTED", classification: "INTERNAL" });
    }
    if (!sources.length) throw new RepositoryConnectionError("This repository has no tracked regular files. Add files with git add before connecting.");
    const revision = (await git(["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() || undefined;
    return { revision, directory: posix.join(config.workerRoot, suffix.split("\\").join("/")), permissions: selection.permissions, sources,
      policyRules: selection.permissions.flatMap(permission => sources.map(source => ({ id: newId("command"), description: `${permission.decision}: ${permission.operation} ${source.name}`, decision: permission.decision, operation: permission.operation, resourcePattern: source.location }))), connectedAt: new Date().toISOString() };
  };
  return connect;
}

/** Capabilities and policy are compiled exclusively from the operator's persisted selection. */
export function applyRepositoryAccess(definition: WorkflowDefinition, access: RepositoryAccess): WorkflowDefinition {
  return WorkflowDefinition.parse({ ...definition, sources: access.sources, policyRules: access.policyRules,
    agents: definition.agents.map(agent => ({ ...agent, capabilities: access.policyRules.map(rule => `${rule.operation}:${rule.resourcePattern}`) })),
    tasks: definition.tasks.map(task => ({ ...task, sourceNames: access.sources.map(source => source.name) })),
  });
}
