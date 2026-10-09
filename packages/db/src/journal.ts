import { and, asc, eq, gt } from "drizzle-orm";
import {
  RunEvent,
  applyEvent,
  newId,
  replay,
  type EventJournal,
  type NewRunEvent,
  type RunSnapshot,
} from "@bastion/contracts";
import type { Db } from "./client";
import { events as eventsTable } from "./schema";
import { materialize } from "./materialize";

type Listener = (event: RunEvent) => void | Promise<void>;

export const toIso = (v: string | Date) => new Date(v).toISOString();

/**
 * Postgres-backed append-only journal.
 *  - seq is gap-free per run, assigned under a per-run lock and guarded by UNIQUE(run_id, seq)
 *  - events + relational rows commit in ONE transaction
 *  - listeners are notified only after commit, strictly in commit order (persist before broadcast)
 * Single-writer process (ARCHITECTURE: one backend process for the MVP).
 */
export class PgEventJournal implements EventJournal {
  private readonly cache = new Map<string, RunSnapshot>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<Listener>();
  private readonly outbox: RunEvent[] = [];
  private draining = false;

  constructor(
    private readonly db: Db,
    private readonly onListenerError: (err: unknown, event: RunEvent) => void = (err) => console.error(err),
  ) {}

  async append(runId: string, batch: NewRunEvent[]): Promise<RunEvent[]> {
    if (batch.length === 0) return [];
    const committed = await this.withLock(runId, async () => {
      const prev = await this.loadSnapshot(runId);
      let next = prev;
      const out: RunEvent[] = [];
      for (const e of batch) {
        if (e.runId !== runId) throw new Error(`event runId ${e.runId} does not match ${runId}`);
        const full = RunEvent.parse({
          ...e,
          eventId: newId("event"),
          seq: (next?.lastSeq ?? 0) + 1,
          timestamp: new Date().toISOString(),
        });
        next = applyEvent(next, full);
        out.push(full);
      }
      await this.db.transaction(async (tx) => {
        await materialize(tx, prev, next!);
        await tx.insert(eventsTable).values(
          out.map((e) => ({
            id: e.eventId,
            runId: e.runId,
            seq: e.seq,
            traceId: e.traceId,
            taskId: e.taskId ?? null,
            agentId: e.agentId ?? null,
            type: e.type,
            payload: e.payload,
            createdAt: e.timestamp,
          })),
        );
      });
      this.cache.set(runId, next!);
      this.outbox.push(...out);
      return out;
    });
    await this.drain();
    return committed;
  }

  async read(runId: string, afterSeq = 0, limit?: number): Promise<RunEvent[]> {
    const q = this.db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.runId, runId), gt(eventsTable.seq, afterSeq)))
      .orderBy(asc(eventsTable.seq));
    const rows = limit ? await q.limit(limit) : await q;
    return rows.map((r) =>
      RunEvent.parse({
        eventId: r.id,
        runId: r.runId,
        seq: r.seq,
        timestamp: toIso(r.createdAt),
        traceId: r.traceId,
        ...(r.taskId ? { taskId: r.taskId } : {}),
        ...(r.agentId ? { agentId: r.agentId } : {}),
        type: r.type,
        payload: r.payload,
      }),
    );
  }

  /** Current authoritative snapshot (null if the run has no events). */
  async snapshot(runId: string): Promise<RunSnapshot | null> {
    return this.withLock(runId, () => this.loadSnapshot(runId));
  }

  onCommitted(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async loadSnapshot(runId: string): Promise<RunSnapshot | null> {
    const cached = this.cache.get(runId);
    if (cached) return cached;
    const all = await this.read(runId);
    if (all.length === 0) return null;
    const s = replay(all);
    this.cache.set(runId, s);
    return s;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }

  /** Deliver committed events in commit order; re-entrant appends from listeners are queued. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length) {
        const e = this.outbox.shift()!;
        for (const l of [...this.listeners]) {
          try {
            await l(e);
          } catch (err) {
            this.onListenerError(err, e);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
