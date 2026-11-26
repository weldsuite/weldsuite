/**
 * A room's checkpoint in R2: the whole document with the revision it is at,
 * as gzipped JSON. One object per document, overwritten by each checkpoint
 * (an R2 put replaces it atomically). The revision travels inside the
 * object, so a room that restarts between writing it and trimming its op log
 * still knows which logged ops the object already contains.
 *
 * Each kind of document keeps its own shape around the revision
 * (`{ revision, doc }` for WeldDocs, `{ revision, workbook }` for WeldSheets,
 * `{ revision, board }` for WeldBoard; the Rust server reads the same
 * objects). Versions are stored the same way under their own keys.
 */

/** What every stored checkpoint has: the revision it is at. */
export interface StoredCheckpoint {
  revision: number;
}

/**
 * Writes the checkpoint; returns its size in bytes. With `onlyIfAbsent` it
 * is written only when the key holds nothing yet (null when it did).
 */
export async function writeCheckpoint<T extends StoredCheckpoint>(bucket: R2Bucket, key: string, checkpoint: T, options: { onlyIfAbsent: true }): Promise<number | null>;
export async function writeCheckpoint<T extends StoredCheckpoint>(bucket: R2Bucket, key: string, checkpoint: T): Promise<number>;
export async function writeCheckpoint<T extends StoredCheckpoint>(bucket: R2Bucket, key: string, checkpoint: T, options?: { onlyIfAbsent?: boolean }): Promise<number | null> {
  const body = await gzip(JSON.stringify(checkpoint));
  const written = await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { revision: String(checkpoint.revision) },
    ...(options?.onlyIfAbsent ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
  });
  // R2 answers null only when a condition stopped the write.
  return options?.onlyIfAbsent && written === null ? null : body.byteLength;
}

/** The checkpoint, or null when none has been written. */
export async function readCheckpoint<T extends StoredCheckpoint>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const text = await new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text) as T;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
