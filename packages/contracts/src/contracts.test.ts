import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  RunEvent,
  RunSnapshot,
  applyEvent,
  replay,
  toGraphView,
  latestExecution,
  SeqGapError,
  DEMO_GROUND_TRUTH,
  ArenaActionCmd,
  newId,
  RunId,
} from "./index";

const raw = JSON.parse(readFileSync(new URL("../fixtures/demo-run.events.json", import.meta.url), "utf8")) as unknown[];

describe("demo fixture", () => {
  const events = raw.map((e) => RunEvent.parse(e));

  it("every event matches the schema and seq is gap-free", () => {
    expect(events.length).toBeGreaterThan(50);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it("replays to a valid, recovered snapshot", () => {
    const s = replay(events);
    expect(() => RunSnapshot.parse(s)).not.toThrow();
    expect(s.run.status).toBe("RECOVERED");
    expect(Object.values(s.incidents)[0]?.state).toBe("RESOLVED");
    expect(s.verification?.every((c) => c.passed)).toBe(true);
  });

  it("independent branch is preserved; affected tasks reran", () => {
    const s = replay(events);
    for (const t of DEMO_GROUND_TRUTH.independent) {
      expect(latestExecution(s, t)?.attempt).toBe(1);
      expect(latestExecution(s, t)?.securityState).toBe("CLEAR");
    }
    expect(latestExecution(s, "task_research")?.attempt).toBe(2);
    expect(latestExecution(s, "task_build")?.attempt).toBe(2);
    expect(latestExecution(s, "task_verify")?.state).toBe("SUCCEEDED");
    expect(s.sources["src_apiguide_v2"]?.securityState).toBe("QUARANTINED");
    expect(s.artifacts["art_notes_v1"]?.trustState).toBe("INVALIDATED");
  });

  it("the exfil request was denied and never executed", () => {
    const s = replay(events);
    const t = s.toolRequests["tool_b1_exfil"];
    expect(t?.decision).toBe("DENY");
    expect(t?.executionOutcome).toBe("NOT_EXECUTED");
  });

  it("incremental application equals full replay (acceptance #7)", () => {
    let live: RunSnapshot | null = null;
    for (const e of events) live = applyEvent(live, e);
    // Overlapping reconnect replay is a no-op.
    for (const e of events.slice(-10)) live = applyEvent(live, e);
    expect(live).toEqual(replay(events));
  });

  it("detects seq gaps", () => {
    const s = replay(events.slice(0, 5));
    expect(() => applyEvent(s, events[6]!)).toThrow(SeqGapError);
  });

  it("graph view edges only reference existing nodes", () => {
    const g = toGraphView(replay(events));
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.nodes.length).toBeGreaterThan(10);
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});

describe("schemas", () => {
  it("rejects ids with the wrong prefix", () => {
    expect(RunId.safeParse("task_x").success).toBe(false);
    expect(RunId.safeParse(newId("run")).success).toBe(true);
  });

  it("arena actions are typed per card; no free-form extras needed", () => {
    expect(
      ArenaActionCmd.safeParse({ commandId: "cmd_1", card: "QUARANTINE", incidentId: "inc_1", sourceVersionId: "src_1" }).success,
    ).toBe(true);
    expect(ArenaActionCmd.safeParse({ commandId: "cmd_1", card: "QUARANTINE", incidentId: "inc_1" }).success).toBe(false);
  });
});
