import { expect, it } from 'vitest';
import { readTaskDocuments } from '../apps/web/src/lib/task-documents';

it('reads original document text and rejects duplicate, binary, empty, and oversized attachments atomically', async () => {
  const content = `Untrusted text ${crypto.randomUUID()}`;
  const file = new File([content], 'vendor.md');
  const current = await readTaskDocuments([file], [], 4096);
  expect(current).toEqual([{ name: 'vendor.md', content }]);
  await expect(readTaskDocuments([file], current, 4096)).rejects.toThrow('already attached');
  await expect(readTaskDocuments([new File([new Uint8Array([0xff, 0xfe])], 'binary.txt')], [], 4096)).rejects.toThrow('UTF-8');
  await expect(readTaskDocuments([new File(['\0'], 'binary.txt')], [], 4096)).rejects.toThrow('supported text');
  await expect(readTaskDocuments([new File(['  '], 'empty.txt')], [], 4096)).rejects.toThrow('empty');
  await expect(readTaskDocuments([new File(['text'], 'office.docx')], [], 4096)).rejects.toThrow('not supported');
  await expect(readTaskDocuments([file], [], 1)).rejects.toThrow('limit');
  expect(current).toEqual([{ name: 'vendor.md', content }]);
});
