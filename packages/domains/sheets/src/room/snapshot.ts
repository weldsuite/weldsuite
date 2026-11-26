/**
 * A sheet's checkpoint in R2: the whole workbook with the revision it is at,
 * as gzipped JSON (@weldsuite/collab/checkpoint), one object per sheet.
 * Versions are stored the same way.
 */

import { readCheckpoint, writeCheckpoint } from '@weldsuite/collab/checkpoint';
import type { WorkbookSnapshot } from '@weldsuite/sheets-engine';

export interface StoredSnapshot {
  revision: number;
  workbook: WorkbookSnapshot;
}

/** Writes the checkpoint; returns its size in bytes. */
export function writeSnapshot(bucket: R2Bucket, key: string, snapshot: StoredSnapshot): Promise<number> {
  return writeCheckpoint(bucket, key, snapshot);
}

/** The checkpoint, or null when none has been written. */
export function readSnapshot(bucket: R2Bucket, key: string): Promise<StoredSnapshot | null> {
  return readCheckpoint<StoredSnapshot>(bucket, key);
}
