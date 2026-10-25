import { describe, expect, it, vi } from 'vitest';
import { BODY, ContentBuilder, DocModel, applyOp, writeDocx, type ImageObject } from '@weldsuite/docs-engine';
import { canImportName, imageFetcher, importFailure, readImport } from './files';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function docxWithPicture(): Promise<Uint8Array> {
  const doc = DocModel.create();
  const b = new ContentBuilder();
  b.addText('Hello ').addObject({ kind: 'image', id: 'i', src: 'file:pic', width: 40, height: 20 }).endParagraph();
  applyOp(doc, { type: 'insert', story: BODY, at: 0, content: b.build() });
  return writeDocx(doc, { images: async () => ({ bytes: PNG, mime: 'image/png' }) });
}

function images(snapshot: { stories: Record<string, { objects?: [number, unknown][] }> }): ImageObject[] {
  return (snapshot.stories[BODY]?.objects ?? []).map(([, o]) => o as ImageObject).filter((o) => o.kind === 'image');
}

describe('fetching pictures for an export', () => {
  it('sends the session token to app-api only, whatever the path', async () => {
    const seen: [string, string | undefined][] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      seen.push([String(input), (init?.headers as Record<string, string> | undefined)?.Authorization]);
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    });
    const fetchImage = imageFetcher(async () => 'secret', 'https://app-api.example');
    await fetchImage('https://app-api.example/api/storage/private/workspaces/w/a.png');
    await fetchImage('https://attacker.example/api/storage/private/x');
    await fetchImage('https://app-api.example/public/logo.png');
    fetchMock.mockRestore();
    expect(seen).toEqual([
      ['https://app-api.example/api/storage/private/workspaces/w/a.png', 'Bearer secret'],
      ['https://attacker.example/api/storage/private/x', undefined],
      ['https://app-api.example/public/logo.png', undefined],
    ]);
  });
});

describe('reading a file into a document', () => {
  it('stores the pictures of a .docx and points the document at them', async () => {
    const store = vi.fn(async (_image: { name: string; bytes: Uint8Array; mime: string }) => 'https://files.example/pic.png');
    const read = await readImport('Report.docx', await docxWithPicture(), store);
    expect(read.name).toBe('Report');
    expect(store).toHaveBeenCalledTimes(1);
    const stored = store.mock.calls[0]![0];
    expect(stored.mime).toBe('image/png');
    expect(Array.from(stored.bytes)).toEqual(Array.from(PNG));
    expect(images(read.snapshot)).toMatchObject([{ src: 'https://files.example/pic.png', width: 40, height: 20 }]);
  });

  it('keeps a picture inside the document when it cannot be stored', async () => {
    const read = await readImport('Report.docx', await docxWithPicture(), async () => null);
    expect(images(read.snapshot)[0]!.src).toMatch(/^data:image\/png;base64,/);
  });

  it('reads Markdown and plain text', async () => {
    const read = await readImport('notes.md', new TextEncoder().encode('# Title\n\nSome *text*'));
    expect(read.name).toBe('notes');
    expect(read.snapshot.stories[BODY]!.text).toBe('Title\nSome text\n');
    expect(read.warnings).toEqual([]);
  });

  it('refuses what it cannot open, with a reason', async () => {
    await expect(readImport('sheet.xlsx', new Uint8Array(4))).rejects.toSatisfy((e) => importFailure(e) === 'unsupported');
    await expect(readImport('broken.docx', new TextEncoder().encode('not a zip'))).rejects.toSatisfy((e) => importFailure(e) === 'not_docx');
    expect(canImportName('a.DOCX')).toBe(true);
    expect(canImportName('a.pdf')).toBe(false);
  });
});
