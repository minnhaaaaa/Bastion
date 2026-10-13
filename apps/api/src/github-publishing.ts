import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db, type PgEventJournal } from "@bastion/db";
import { toolApprovalDigest, type PendingToolApproval } from "@bastion/security";
import type { RunSnapshot, Workflow } from "@bastion/contracts";
import { RepositoryAccess } from "./repository-access";
import type { GitHubAuth } from "./github-auth";

class PublicationError extends Error {}

type ApprovedFile = { path: string; content: string };

/** Only successful, exact human-approved writes can become publication content. */
export function approvedFiles(s: RunSnapshot, access: RepositoryAccess, records: PendingToolApproval[], executed: string[]): ApprovedFile[] {
  if (s.run.mode !== "PROTECTED" || s.run.status !== "COMPLETED" || !s.verification?.length || s.verification.some(c => !c.passed) || Object.values(s.sources).some(source => source.securityState !== "CLEAR") || Object.values(s.artifacts).some(a => a.trustState !== "CLEAR")) throw new PublicationError("Run must complete and pass its recorded checks before publishing.");
  const files = new Map<string, string>();
  for (const id of executed) {
    const request = s.toolRequests[id];
    if (!request || request.operation !== "fs.write" || request.executionOutcome !== "SUCCESS") continue;
    const approval = Object.values(s.toolApprovals).find(a => a.toolRequestId === id && a.status === "CONSUMED" && a.actorId?.startsWith("user_"));
    const record = records.find(r => r.request.toolRequestId === id);
    if (!approval || !record || request.decision !== "ALLOW" || record.status !== "CONSUMED") throw new PublicationError("A successful write has no matching human approval.");
    const { actionDigest, status: _status, ...data } = record;
    if (toolApprovalDigest(data) !== actionDigest || approval.actionDigest !== actionDigest || record.call.runId !== s.run.id || record.call.executionId !== request.executionId || record.workflowId !== s.run.workflowId || record.workflowVersion !== s.run.workflowVersion || record.request.operation !== "fs.write") throw new PublicationError("Approved write evidence no longer matches this run.");
    if (record.request.inputClassification === "SYNTHETIC_SECRET") throw new PublicationError("Secret-classified inputs cannot be published to GitHub.");
    const path = record.request.resource, content = record.call.args.content;
    if (typeof content !== "string" || record.call.args.path !== path || request.resource !== createHash("sha256").update(path).digest("hex") || !access.sources.some(source => source.location === path)) throw new PublicationError("Write target is outside the connected repository.");
    const name = posix.relative(access.directory, path);
    if (!name || name.startsWith("../") || posix.isAbsolute(name) || name.split("/").includes(".git")) throw new PublicationError("Invalid repository write target.");
    files.set(name, content);
  }
  return [...files].map(([path, content]) => ({ path, content }));
}

/** Single-controller publisher. Its own persisted lifecycle does not change run evidence. */
export class GitHubPublishing {
  private pending = new Map<string, Promise<void>>();
  constructor(private db: Db, private journal: PgEventJournal, private auth: GitHubAuth, private hostRoot: string, private workerRoot: string, private request: typeof fetch = fetch) {}
  async pin(runId: string, workflow: Workflow) {
    const [row] = await this.db.select().from(schema.projectConnections).where(eq(schema.projectConnections.projectId, workflow.projectId));
    if (!row?.repository) return;
    const access = RepositoryAccess.parse(row.repository);
    if (!access.remoteUrl || !access.revision || !access.permissions.some(p => p.operation === "fs.write")) return;
    if (!workflow.definition.sources.length || !workflow.definition.sources.some(source => access.sources.some(file => file.location === source.location))) return;
    await this.db.insert(schema.runPullRequests).values({ runId, repository: access, requested: true, status: "WAITING" }).onConflictDoNothing();
  }
  async status(runId: string) {
    const [row] = await this.db.select({ status: schema.runPullRequests.status, url: schema.runPullRequests.url, message: schema.runPullRequests.message }).from(schema.runPullRequests).where(and(eq(schema.runPullRequests.runId, runId), eq(schema.runPullRequests.requested, true)));
    return row ?? null;
  }
  publish(runId: string) {
    const existing = this.pending.get(runId); if (existing) return existing;
    const work = this.perform(runId).finally(() => this.pending.delete(runId));
    this.pending.set(runId, work); return work;
  }
  async idle() { await Promise.allSettled(this.pending.values()); }
  async resume() {
    const rows = await this.db.select({ runId: schema.runPullRequests.runId }).from(schema.runPullRequests).where(and(eq(schema.runPullRequests.requested, true), inArray(schema.runPullRequests.status, ["WAITING", "PUBLISHING"])));
    for (const row of rows) {
      const s = await this.journal.snapshot(row.runId);
      if (s?.run.status === "COMPLETED") await this.publish(row.runId);
    }
  }
  private async perform(runId: string) {
    const [job] = await this.db.select().from(schema.runPullRequests).where(eq(schema.runPullRequests.runId, runId));
    if (!job || !job.requested || job.status === "CREATED" || job.status === "SKIPPED") return;
    const update = (values: Partial<typeof schema.runPullRequests.$inferInsert>) => this.db.update(schema.runPullRequests).set({ ...values, updatedAt: new Date().toISOString() }).where(eq(schema.runPullRequests.runId, runId));
    try {
      const s = await this.journal.snapshot(runId);
      if (!s) throw new PublicationError("Run evidence is unavailable.");
      const [project] = await this.db.select().from(schema.projects).where(eq(schema.projects.id, s.run.projectId));
      const [run] = await this.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!project || project.deletedAt || !run || run.deletedAt) throw new PublicationError("Project or run is no longer available.");
      const access = RepositoryAccess.parse(job.repository);
      const records = await this.db.select().from(schema.toolApprovals).where(and(eq(schema.toolApprovals.runId, runId), eq(schema.toolApprovals.status, "CONSUMED")));
      const events = await this.journal.read(runId);
      const files = approvedFiles(s, access, records.map(row => ({ ...(row.record as PendingToolApproval), status: row.status })), events.filter(e => e.type === "tool.executed" && e.payload.outcome === "SUCCESS").map(e => (e.payload as { toolRequestId: string }).toolRequestId));
      if (!files.length) { await update({ status: "SKIPPED", message: "No successful approved file edits to publish." }); return; }
      // Detect later local edits; never silently publish content different from the approved action.
      const root = await realpath(this.hostRoot);
      for (const file of files) {
        const path = resolve(root, posix.relative(this.workerRoot, posix.join(access.directory, file.path)));
        const rel = relative(root, path);
        if (rel.startsWith("../") || isAbsolute(rel) || await realpath(path) !== path || await readFile(path, "utf8") !== file.content) throw new PublicationError("Local files changed after approval. Start a new reviewed task.");
      }
      const remote = new URL(access.remoteUrl!);
      if (remote.origin !== new URL(this.auth.config.authorizeUrl).origin || !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/?$/.test(remote.pathname)) throw new PublicationError("Repository does not match the configured GitHub host.");
      const [owner, repo] = remote.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "").split("/");
      let token: string;
      try { token = await this.auth.accessToken(project.ownerId); } catch { throw new PublicationError("Connect GitHub with repository write access, then retry publishing."); }
      const api = async (suffix: string, body?: unknown) => {
        if (body !== undefined) {
          const current = await this.journal.snapshot(runId);
          if (!current) throw new PublicationError("Run evidence is unavailable.");
          approvedFiles(current, access, records.map(row => ({ ...(row.record as PendingToolApproval), status: row.status })), events.filter(e => e.type === "tool.executed" && e.payload.outcome === "SUCCESS").map(e => (e.payload as { toolRequestId: string }).toolRequestId));
          const [stillVisible] = await this.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
          if (!stillVisible || stillVisible.deletedAt) throw new PublicationError("Run is no longer available.");
        }
        const url = new URL(`/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}${suffix ? `/${suffix}` : ""}`, this.auth.config.userUrl);
        const response = await this.request(url, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(this.auth.config.timeoutMs), headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) throw new PublicationError(`GitHub request failed (HTTP ${response.status}) at ${suffix ? suffix.split("?")[0] : "repository details"}. Check account access and retry.`);
        return await response.json() as any;
      };
      await update({ status: "PUBLISHING", message: "Publishing approved edits to a pull request." });
      const branch = `bastion/${runId}`;
      const existing = await api(`pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      const finish = async (pr: { html_url: string }) => {
        const url = new URL(pr.html_url);
        if (url.origin !== remote.origin || !url.pathname.startsWith(`/${owner}/${repo}/pull/`)) throw new PublicationError("GitHub returned an unexpected pull request URL.");
        await update({ status: "CREATED", url: url.href, message: "Pull request created. Merge it on GitHub to update the base branch." });
      };
      if (existing.length) { if (!job.commitSha || existing[0].head?.sha !== job.commitSha) throw new PublicationError("The existing pull request does not match this run’s published commit."); await finish(existing[0]); return; }
      const metadata = await api("");
      const base = metadata.default_branch;
      const head = await api(`git/ref/heads/${encodeURIComponent(base)}`);
      if (head.object?.sha !== access.revision) throw new PublicationError("GitHub changed since this task started. Start a new task against the latest revision.");
      let commit = job.commitSha;
      if (!commit) {
        const original = await api(`git/commits/${access.revision}`);
        const originalTree = await api(`git/trees/${original.tree.sha}?recursive=1`);
        if (originalTree.truncated || !Array.isArray(originalTree.tree)) throw new PublicationError("The GitHub tree could not be fully verified.");
        const entries = files.map(file => {
          const entry = originalTree.tree.find((node: any) => node.path === file.path);
          if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new PublicationError("An approved file is not a regular file in the pinned GitHub revision.");
          return { path: file.path, mode: entry.mode, type: "blob", content: file.content };
        });
        const tree = await api("git/trees", { base_tree: original.tree.sha, tree: entries });
        const created = await api("git/commits", { message: `Apply approved Bastion edits (${runId})`, tree: tree.sha, parents: [access.revision] });
        commit = created.sha; await update({ commitSha: commit });
      }
      // A deterministic per-run branch makes retries recoverable without force-pushing.
      const refs = await api(`git/matching-refs/heads/${encodeURIComponent(branch)}`);
      const ref = refs.find((r: any) => r.ref === `refs/heads/${branch}`);
      if (ref && ref.object.sha !== commit) throw new PublicationError("The publication branch changed. It will not be overwritten.");
      if (!ref) await api("git/refs", { ref: `refs/heads/${branch}`, sha: commit });
      const pr = await api("pulls", { title: `Approved repository edits · ${runId}`, head: branch, base, body: `Changes from Bastion run ${runId}.\n\nIncludes only successful human-approved file writes. Recorded run checks passed. Review the diff before merging.` });
      await finish(pr);
    } catch (error) {
      // Only our own fixed errors or sanitized credential errors reach the UI; no remote bodies.
      await update({ status: "FAILED", message: error instanceof PublicationError ? error.message : "Could not publish approved edits. Check repository access and retry." });
    }
  }
}
