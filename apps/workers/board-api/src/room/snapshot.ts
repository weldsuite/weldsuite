/**
 * A board's checkpoint in R2: the whole board with the revision it is at, as
 * gzipped JSON. One object per board, overwritten by each checkpoint (an R2
 * put replaces it atomically). The revision travels inside the object, so a
 * room that restarts between writing it and trimming its op log still knows
 * which logged ops the object already contains.
 *
 * Next to it, a small SVG thumbnail of the board for the home page and
 * WeldDrive, redrawn at each checkpoint.
 */

import type { BoardSnapshot } from '@weldsuite/board-engine';

export interface StoredSnapshot {
  revision: number;
  board: BoardSnapshot;
}

/**
 * Writes the checkpoint; returns its size in bytes. With `onlyIfAbsent` it
 * is written only when the key holds nothing yet (null when it did).
 */
export async function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot, options: { onlyIfAbsent: true }): Promise<number | null>;
export async function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot): Promise<number>;
export async function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot, options?: { onlyIfAbsent?: boolean }): Promise<number | null> {
  const body = await gzip(JSON.stringify(snapshot));
  const written = await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { revision: String(snapshot.revision) },
    ...(options?.onlyIfAbsent ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
  });
  return written === null ? null : body.byteLength;
}

/** The checkpoint, or null when none has been written. */
export async function readSnapshot(bucket: R2Bucket, key: string): Promise<StoredSnapshot | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const text = await new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text) as StoredSnapshot;
}

/** Where a board's thumbnail sits: next to its checkpoint. */
export function thumbnailKeyFor(snapshotKey: string): string {
  const slash = snapshotKey.lastIndexOf('/');
  return `${snapshotKey.slice(0, slash + 1)}thumbnail.svg`;
}

export async function writeThumbnail(bucket: R2Bucket, snapshotKey: string, svg: string): Promise<void> {
  await bucket.put(thumbnailKeyFor(snapshotKey), svg, { httpMetadata: { contentType: 'image/svg+xml' } });
}

export async function readThumbnail(bucket: R2Bucket, snapshotKey: string): Promise<string | null> {
  const object = await bucket.get(thumbnailKeyFor(snapshotKey));
  return object ? new Response(object.body).text() : null;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
