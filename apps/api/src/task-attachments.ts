import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, posix, basename } from "node:path";
import { z } from "zod";
import { WorkflowDefinition, type SourceDefinition } from "@bastion/contracts";
import { HttpError } from "./errors";

export const TaskDocument = z.object({
  name: z.string().trim().min(1).max(255).refine(name => !/[\\/\x00-\x1f]/.test(name), "Use a filename without path separators"),
  content: z.string().min(1),
}).strict();
export type TaskDocument = z.infer<typeof TaskDocument>;
export type TaskAttachmentStore = ReturnType<typeof taskAttachmentStore>;

/** Operator-supplied documents are evidence, never capability grants or planner instructions. */
export function taskAttachmentStore(config: { hostRoot: string; workerRoot: string; maxBytes: number }) {
  if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0) throw new Error("Invalid attachment byte budget");
  function validate(documents: TaskDocument[]) {
    if (new Set(documents.map(document => document.name)).size !== documents.length) throw new HttpError("VALIDATION", "Attached filenames must be unique");
    let bytes = 0;
    for (const document of documents) {
      TaskDocument.parse(document);
      if (/\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(document.name) || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(document.content) || document.content.startsWith("%PDF-")) throw new HttpError("VALIDATION", "Attach UTF-8 text documents. PDF and Office files are not supported yet.");
      bytes += Buffer.byteLength(document.content) + Buffer.byteLength(document.name);
    }
    if (bytes > config.maxBytes) throw new HttpError("VALIDATION", `Attachments exceed the ${config.maxBytes}-byte document budget`);
  }
  return {
    maxBytes: config.maxBytes,
    validate,
    async persist(documents: TaskDocument[]) {
      validate(documents);
      const root = await realpath(config.hostRoot);
      const directory = await mkdtemp(join(root, "attachments-"));
      const discard = () => rm(directory, { recursive: true, force: true });
      try {
        const sources: SourceDefinition[] = [];
        for (const document of documents) {
          const file = crypto.randomUUID();
          await writeFile(join(directory, file), document.content, { flag: "wx", mode: 0o400 });
          sources.push({ name: `Attachment: ${document.name}`, location: posix.join(config.workerRoot, basename(directory), file), trust: "UNTRUSTED", classification: "INTERNAL" });
        }
        return { sources, discard };
      } catch (error) { await discard(); throw error; }
    },
  };
}

export function attachTaskSources(definition: WorkflowDefinition, sources: SourceDefinition[]) {
  return WorkflowDefinition.parse({ ...definition, sources: [...definition.sources, ...sources], tasks: definition.tasks.map(task => ({ ...task, sourceNames: [...task.sourceNames, ...sources.map(source => source.name)] })) });
}
