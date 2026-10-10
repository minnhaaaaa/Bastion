export type TaskDocument = { name: string; content: string };

/** Decode strictly: silently replacing bytes would change the user's evidence. */
export async function readTaskDocuments(files: File[], current: TaskDocument[], maxBytes: number): Promise<TaskDocument[]> {
  const encoder = new TextEncoder();
  const names = new Set(current.map(document => document.name));
  let bytes = current.reduce((sum, document) => sum + encoder.encode(document.content).length + encoder.encode(document.name).length, 0);
  const result = [...current];
  for (const file of files) {
    const name = file.name.trim();
    if (!name || name.length > 255 || /[\\/\x00-\x1f]/.test(name)) throw new Error("Choose documents with valid filenames.");
    if (names.has(name)) throw new Error(`${name} is already attached. Rename one file to attach both.`);
    bytes += file.size + encoder.encode(name).length;
    if (bytes > maxBytes) throw new Error(`Files exceed the controller's ${maxBytes.toLocaleString()}-byte attachment limit.`);
    if (/\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(name)) throw new Error(`${name}: attach a text version. PDF and Office files are not supported yet.`);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error(`${name} is not a UTF-8 text document.`); }
    if (!content.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(content) || content.startsWith("%PDF-")) throw new Error(`${name} is empty or is not a supported text document.`);
    names.add(name); result.push({ name, content });
  }
  return result;
}
