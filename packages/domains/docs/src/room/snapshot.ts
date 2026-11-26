/**
 * A document's checkpoint in R2: the whole document with the revision it is
 * at, as gzipped JSON (@weldsuite/collab/checkpoint), one object per
 * document. Versions are stored the same way.
 */

import { readCheckpoint, writeCheckpoint } from '@weldsuite/collab/checkpoint';
import type { DocSnapshot } from '@weldsuite/docs-engine';

export interface StoredSnapshot {
  revision: number;
  doc: DocSnapshot;
}

/** Writes the checkpoint; returns its size in bytes. */
export function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot): Promise<number> {
  return writeCheckpoint(bucket, key, snapshot);
}

/** The checkpoint, or null when none has been written. */
export function readSnapshot(bucket: R2Bucket, key: string): Promise<StoredSnapshot | null> {
  return readCheckpoint<StoredSnapshot>(bucket, key);
}
