import { open } from "node:fs/promises";
import { constants } from "node:fs";

export async function boundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Source must be a regular file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes) throw new Error("Source exceeds size limit");
    return buffer.subarray(0, bytes);
  } finally { await file.close(); }
}

export async function boundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Source exceeds size limit");
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts, bytes);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
