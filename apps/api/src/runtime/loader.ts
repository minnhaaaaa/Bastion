import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";

/**
 * Loads workflow source / attack payload content for the controller. Locations are confined to
 * the sandbox workspace (worker-namespace absolute paths or workspace-relative paths) or to the
 * configured HTTP origins. Anything else is refused.
 */
export function sandboxLoader(cfg: { hostRoot: string; workerRoot: string; httpOrigins: string[]; timeoutMs: number; maxBytes: number }) {
  return async (location: string): Promise<string> => {
    if (/^https?:\/\//i.test(location)) {
      const url = new URL(location);
      if (!cfg.httpOrigins.includes(url.origin) || url.username || url.password) throw new Error("Source origin not allowed");
      const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(cfg.timeoutMs) });
      if (!res.ok) throw new Error(`Source fetch failed (${res.status})`);
      const text = await res.text();
      if (Buffer.byteLength(text) > cfg.maxBytes) throw new Error("Source exceeds size limit");
      return text;
    }
    const root = await realpath(cfg.hostRoot);
    const rel = posix.isAbsolute(location) ? posix.relative(cfg.workerRoot, location) : location;
    const canonical = await realpath(resolve(root, rel));
    const suffix = relative(root, canonical);
    if (suffix === ".." || suffix.startsWith("../") || suffix.startsWith("..\\") || isAbsolute(suffix)) throw new Error("Source path escapes sandbox");
    const buf = await readFile(canonical);
    if (buf.length > cfg.maxBytes) throw new Error("Source exceeds size limit");
    return buf.toString("utf8");
  };
}
