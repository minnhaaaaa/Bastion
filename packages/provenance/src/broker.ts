import type {
  ArtifactBroker,
  ArtifactVersion,
  Classification,
  NewRunEvent,
  PublishArtifactInput,
  RunSnapshot,
  SecurityState,
  SourceVersion,
} from "@bastion/contracts";
import { newId } from "@bastion/contracts";
import type { BlobStore } from "./blobs";
import { redactPreview } from "./redact";

/** What the broker needs from the journal (implemented by PgEventJournal). */
export interface JournalAccess {
  append(runId: string, events: NewRunEvent[]): Promise<unknown>;
  snapshot(runId: string): Promise<RunSnapshot | null>;
}

/** Resolves which run owns a version id (implemented by RunRepository). */
export interface VersionLocator {
  runOfVersion(versionId: string): Promise<string | null>;
}

export class UnusableInputError extends Error {
  constructor(readonly versionId: string, readonly state: string) {
    super(`input ${versionId} is ${state} and cannot be consumed`);
  }
}

const RANK: Record<Classification, number> = { PUBLIC: 0, INTERNAL: 1, SYNTHETIC_SECRET: 2 };
const maxClass = (xs: Classification[]): Classification =>
  xs.reduce<Classification>((a, b) => (RANK[b] > RANK[a] ? b : a), "PUBLIC");

/**
 * Brokered artifact handoff (ARCHITECTURE §4.3). Every cross-agent input/output goes through here,
 * which is what makes the provenance graph *observed* rather than inferred.
 */
export class PgArtifactBroker implements ArtifactBroker {
  constructor(
    private readonly journal: JournalAccess,
    private readonly locator: VersionLocator,
    private readonly blobs: BlobStore,
  ) {}

  private async snap(runId: string): Promise<RunSnapshot> {
    const s = await this.journal.snapshot(runId);
    if (!s) throw new Error(`unknown run ${runId}`);
    return s;
  }

  async ingestSource(input: {
    runId: string;
    name: string;
    content: string;
    trust: "TRUSTED" | "UNTRUSTED";
    classification: Classification;
    previousVersionId?: string;
    traceId: string;
  }): Promise<SourceVersion> {
    const s = await this.snap(input.runId);
    const prior = Object.values(s.sources)
      .filter((x) => x.name === input.name)
      .sort((a, b) => b.version - a.version);
    const previous = input.previousVersionId ? s.sources[input.previousVersionId] : prior[0];
    if (input.previousVersionId && !previous) throw new Error(`unknown previous version ${input.previousVersionId}`);
    const { blobRef, contentHash } = await this.blobs.put(input.content);
    const id = newId("source");
    const common = {
      sourceVersionId: id,
      name: input.name,
      version: (prior[0]?.version ?? 0) + 1,
      contentHash,
      trust: input.trust,
      classification: input.classification,
      blobRef,
      preview: redactPreview(input.content),
    };
    await this.journal.append(input.runId, [
      previous
        ? { runId: input.runId, traceId: input.traceId, type: "source.modified", payload: { ...common, previousVersionId: previous.id } }
        : { runId: input.runId, traceId: input.traceId, type: "source.ingested", payload: common },
    ]);
    return (await this.snap(input.runId)).sources[id]!;
  }

  async latestUsableSource(runId: string, name: string): Promise<SourceVersion | null> {
    const s = await this.snap(runId);
    return (
      Object.values(s.sources)
        .filter((x) => x.name === name && x.securityState === "CLEAR")
        .sort((a, b) => b.version - a.version)[0] ?? null
    );
  }

  async publish(input: PublishArtifactInput): Promise<ArtifactVersion> {
    const s = await this.snap(input.runId);
    const exec = s.executions[input.producerExecutionId];
    if (!exec || exec.taskId !== input.producerTaskId) throw new Error(`unknown producer execution ${input.producerExecutionId}`);
    if (exec.state !== "RUNNING") throw new Error(`producer execution is ${exec.state}, not RUNNING`);

    // Observed inputs of the producer = everything it consumed through the broker.
    const inputs = s.edges.filter((e) => e.relation === "CONSUMED" && e.toId === exec.id).map((e) => e.fromId);
    const derivedFrom = inputs.filter((id) => id.startsWith("art_"));
    const directSources = inputs.filter((id) => id.startsWith("src_"));
    const sourceIds = [...new Set([...directSources, ...derivedFrom.flatMap((a) => s.artifacts[a]?.sourceIds ?? [])])];
    const classification = maxClass([
      input.classification,
      ...derivedFrom.map((a) => s.artifacts[a]!.classification),
      ...directSources.map((x) => s.sources[x]!.classification),
    ]);

    const { blobRef, contentHash } = await this.blobs.put(input.content);
    const version = Math.max(0, ...Object.values(s.artifacts).filter((a) => a.name === input.name).map((a) => a.version)) + 1;
    const id = newId("artifact");
    await this.journal.append(input.runId, [
      {
        runId: input.runId,
        traceId: input.traceId,
        taskId: input.producerTaskId,
        type: "artifact.published",
        payload: {
          artifactVersionId: id,
          name: input.name,
          version,
          contentHash,
          producerExecutionId: exec.id,
          producerTaskId: exec.taskId,
          sourceIds,
          derivedFrom,
          classification,
          trustState: "CLEAR",
          blobRef,
          preview: redactPreview(input.content),
        },
      },
    ]);
    return (await this.snap(input.runId)).artifacts[id]!;
  }

  async consume(input: {
    runId: string;
    inputVersionId: string;
    consumerExecutionId: string;
    consumerTaskId: string;
    traceId: string;
  }): Promise<{ content: string | Uint8Array; classification: Classification }> {
    const s = await this.snap(input.runId);
    const exec = s.executions[input.consumerExecutionId];
    if (!exec || exec.taskId !== input.consumerTaskId) throw new Error(`unknown consumer execution ${input.consumerExecutionId}`);
    const v = s.sources[input.inputVersionId] ?? s.artifacts[input.inputVersionId];
    if (!v) throw new Error(`unknown input version ${input.inputVersionId}`);
    const state = "securityState" in v ? v.securityState : v.trustState;
    if (state !== "CLEAR") throw new UnusableInputError(v.id, state);

    await this.journal.append(input.runId, [
      {
        runId: input.runId,
        traceId: input.traceId,
        taskId: input.consumerTaskId,
        type: "artifact.consumed",
        payload: { inputVersionId: v.id, consumerExecutionId: exec.id, consumerTaskId: exec.taskId },
      },
    ]);
    return { content: await this.blobs.get(v.blobRef), classification: v.classification };
  }

  async isUsable(versionId: string): Promise<boolean> {
    const runId = await this.locator.runOfVersion(versionId);
    if (!runId) return false;
    const s = await this.snap(runId);
    const v = s.sources[versionId] ?? s.artifacts[versionId];
    if (!v) return false;
    return ("securityState" in v ? v.securityState : v.trustState) === "CLEAR";
  }

  async setTrust(versionId: string, state: SecurityState, incidentId?: string): Promise<void> {
    const runId = await this.locator.runOfVersion(versionId);
    if (!runId) throw new Error(`unknown version ${versionId}`);
    const s = await this.snap(runId);
    const traceId = newId("trace");
    const src = s.sources[versionId];
    if (src) {
      if (src.securityState === state) return;
      await this.journal.append(runId, [
        { runId, traceId, type: "source.security_state_changed", payload: { sourceVersionId: versionId, from: src.securityState, to: state, ...(incidentId ? { incidentId } : {}) } },
      ]);
      return;
    }
    const art = s.artifacts[versionId];
    if (!art) throw new Error(`unknown version ${versionId}`);
    if (art.trustState === state) return;
    await this.journal.append(runId, [
      { runId, traceId, type: "artifact.trust_changed", payload: { artifactVersionId: versionId, from: art.trustState, to: state, ...(incidentId ? { incidentId } : {}) } },
    ]);
  }

  /** Raw content for authorized server-side consumers (never broadcast). */
  async content(runId: string, versionId: string): Promise<Uint8Array> {
    const s = await this.snap(runId);
    const v = s.sources[versionId] ?? s.artifacts[versionId];
    if (!v) throw new Error(`unknown version ${versionId}`);
    return this.blobs.get(v.blobRef);
  }
}
