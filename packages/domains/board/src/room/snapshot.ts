/**
 * A board's checkpoint in R2: the whole board with the revision it is at, as
 * gzipped JSON (@weldsuite/collab/checkpoint), one object per board.
 * Versions are stored the same way.
 *
 * Next to it, a small SVG thumbnail of the board for the home page and
 * WeldDrive, redrawn at each checkpoint.
 */

import { readCheckpoint, writeCheckpoint } from '@weldsuite/collab/checkpoint';
import type { BoardSnapshot } from '@weldsuite/board-engine';

export interface StoredSnapshot {
  revision: number;
  board: BoardSnapshot;
}

/**
 * Writes the checkpoint; returns its size in bytes. With `onlyIfAbsent` it
 * is written only when the key holds nothing yet (null when it did).
 */
export function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot, options: { onlyIfAbsent: true }): Promise<number | null>;
export function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot): Promise<number>;
export function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot, options?: { onlyIfAbsent: true }): Promise<number | null> {
  return options ? writeCheckpoint(bucket, key, snapshot, options) : writeCheckpoint(bucket, key, snapshot);
}

/** The checkpoint, or null when none has been written. */
export function readSnapshot(bucket: R2Bucket, key: string): Promise<StoredSnapshot | null> {
  return readCheckpoint<StoredSnapshot>(bucket, key);
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
