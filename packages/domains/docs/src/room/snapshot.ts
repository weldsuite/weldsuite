/**
 * A document's checkpoint in R2: the whole document with the revision it is
 * at, as gzipped JSON. One object per document, overwritten by each
 * checkpoint (an R2 put replaces it atomically). The revision travels inside
 * the object, so a room that restarts between writing it and trimming its op
 * log still knows which logged ops the object already contains.
 */

import type { DocSnapshot } from '@weldsuite/docs-engine';

export interface StoredSnapshot {
  revision: number;
  doc: DocSnapshot;
}

/** Writes the checkpoint; returns its size in bytes. */
export async function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot): Promise<number> {
  const body = await gzip(JSON.stringify(snapshot));
  await bucket.put(key, body, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { revision: String(snapshot.revision) } });
  return body.byteLength;
}

/** The checkpoint, or null when none has been written. */
export async function readSnapshot(bucket: R2Bucket, key: string): Promise<StoredSnapshot | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const text = await new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text) as StoredSnapshot;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
