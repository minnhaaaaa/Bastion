import { newId, RunEvent, replay } from "../packages/contracts/src/index";
import type { EventJournal, NewRunEvent, ArtifactBroker, ArtifactVersion, SourceVersion, Classification } from "../packages/contracts/src/index";

export class MemoryJournal implements EventJournal {
  events: RunEvent[] = [];
  listeners = new Set<(event: RunEvent) => void>();
  async append(runId: string, input: NewRunEvent[]): Promise<RunEvent[]> {
    const seq = this.events.filter(e => e.runId === runId).length;
    const events = input.map((event, i) => RunEvent.parse({ ...event, runId, eventId: newId("event"), seq: seq + i + 1, timestamp: new Date().toISOString() }));
    this.events.push(...events);
    events.forEach(e => this.listeners.forEach(listener => listener(e)));
    return events;
  }
  async read(runId: string, afterSeq = 0) { return this.events.filter(e => e.runId === runId && e.seq > afterSeq); }
  onCommitted(listener: (event: RunEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  snapshot(runId: string) { return replay(this.events.filter(e => e.runId === runId)); }
}

export class MemoryBroker implements ArtifactBroker {
  versions = new Map<string, SourceVersion | ArtifactVersion>();
  contents = new Map<string, string | Uint8Array>();
  unusable = new Set<string>();
  consumed: { inputVersionId: string; consumerExecutionId: string }[] = [];
  async isUsable(id: string) { return this.versions.has(id) && !this.unusable.has(id); }
  async setTrust(id: string) { this.unusable.add(id); }
  async ingestSource(input: Parameters<ArtifactBroker["ingestSource"]>[0]) {
    const versions = [...this.versions.values()].filter(v => v.runId === input.runId && v.name === input.name);
    const version: SourceVersion = { id: newId("source"), runId: input.runId, name: input.name, version: versions.length + 1, contentHash: newId("trace"), trust: input.trust, securityState: "CLEAR", classification: input.classification, blobRef: newId("artifact"), preview: "" };
    this.versions.set(version.id, version); this.contents.set(version.id, input.content); return version;
  }
  async latestUsableSource(runId: string, name: string) {
    return [...this.versions.values()].reverse().find((v): v is SourceVersion => "trust" in v && v.runId === runId && v.name === name && !this.unusable.has(v.id)) ?? null;
  }
  async consume(input: Parameters<ArtifactBroker["consume"]>[0]) {
    if (!await this.isUsable(input.inputVersionId)) throw new Error("Unusable");
    this.consumed.push(input);
    return { content: this.contents.get(input.inputVersionId)!, classification: this.versions.get(input.inputVersionId)!.classification };
  }
  async publish(input: Parameters<ArtifactBroker["publish"]>[0]) {
    const version: ArtifactVersion = { id: newId("artifact"), runId: input.runId, name: input.name, version: [...this.versions.values()].filter(v => v.name === input.name).length + 1, contentHash: newId("trace"), sourceIds: [], producerExecutionId: input.producerExecutionId, classification: input.classification, trustState: "CLEAR", blobRef: newId("artifact"), preview: "" };
    this.versions.set(version.id, version); this.contents.set(version.id, input.content); return version;
  }
}

export const inputClassification = (values: Classification[]): Classification => values.includes("SYNTHETIC_SECRET") ? "SYNTHETIC_SECRET" : values.includes("INTERNAL") ? "INTERNAL" : "PUBLIC";
