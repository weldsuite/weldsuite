import { describe, expect, it } from 'vitest';
import { DocModel } from '@weldsuite/docs-engine';
import { DOC_SNAPSHOT_MAX_BYTES } from '@weldsuite/app-api-client/schemas/docs';
import { docEngine, docEngineNamespace, gzipJson } from './engine-ops';

async function gunzip(bytes: Uint8Array): Promise<unknown> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

describe('docEngine.newDocument', () => {
  it('starts an empty document when the client sent none', async () => {
    const made = await docEngine.newDocument();
    expect(made).toMatchObject({ ok: true, revision: 0 });
    if (!made.ok) throw new Error('refused');
    expect(await gunzip(made.checkpoint)).toEqual({ revision: 0, doc: DocModel.create().toSnapshot() });
  });

  it('starts from the snapshot the client sent, as the engine reads it', async () => {
    const sent = DocModel.create().toSnapshot();
    const made = await docEngine.newDocument(JSON.stringify(sent));
    if (!made.ok) throw new Error('refused');
    expect(await gunzip(made.checkpoint)).toEqual({ revision: 0, doc: DocModel.fromSnapshot(sent).toSnapshot() });
  });

  it('refuses a snapshot that is too large or not a document', async () => {
    const huge = { ...DocModel.create().toSnapshot(), filler: 'x'.repeat(DOC_SNAPSHOT_MAX_BYTES) };
    expect(await docEngine.newDocument(JSON.stringify(huge))).toEqual({ ok: false, reason: 'too_large' });
    expect(await docEngine.newDocument(JSON.stringify({ stories: 'none' }))).toEqual({ ok: false, reason: 'invalid_snapshot' });
  });
});

describe('gzipJson', () => {
  it('writes the bytes the room’s checkpoints hold', async () => {
    expect(await gunzip(await gzipJson({ revision: 3, doc: { a: 1 } }))).toEqual({ revision: 3, doc: { a: 1 } });
  });
});

describe('docEngineNamespace', () => {
  it('answers every name with the engine, as a namespace binding would', () => {
    const ns = docEngineNamespace();
    expect(ns.get()).toBe(docEngine);
    expect(ns.idFromName('doc_1')).toEqual({ name: 'doc_1' });
  });
});
