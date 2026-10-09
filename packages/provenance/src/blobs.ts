import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface BlobStore {
  put(content: string | Uint8Array): Promise<{ blobRef: string; contentHash: string }>;
  get(blobRef: string): Promise<Uint8Array>;
}

/** Content-addressed blob store on local disk. Root directory comes from config (BLOB_DIR). */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(content: string | Uint8Array) {
    const hex = sha256(content);
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, hex), content);
    return { blobRef: `blob:sha256:${hex}`, contentHash: `sha256:${hex}` };
  }

  async get(blobRef: string) {
    const m = /^blob:sha256:([0-9a-f]{64})$/.exec(blobRef);
    if (!m) throw new Error(`invalid blobRef ${blobRef}`);
    return new Uint8Array(await readFile(join(this.root, m[1]!)));
  }
}
