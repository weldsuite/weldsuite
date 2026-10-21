/**
 * Move existing private drive files out of the public bucket (TASK-620).
 *
 * Uploads made before the private bucket existed sit in `STORAGE`, which is
 * served by the public `R2_PUBLIC_URL` domain, and their `files.url` points
 * there. One batch of this walk, per call:
 *
 *   1. copy the object to `PRIVATE_STORAGE` under the same key;
 *   2. point the row at the private URL (`bucket = 'private'`);
 *   3. delete the public copy, which is what actually closes the exposure.
 *
 * The order makes a crash at any point safe to re-run: the row is picked up
 * again until step 2 lands, and step 1 is skipped when the object is already
 * in the private bucket. Readers keep working in between because they read
 * through `getStoredObject` (private first, then public).
 *
 * Scope: drive files only (`entity_type IS NULL`, `is_public = false`).
 * Files that belong to another module's record (ticket, mail, CRM, project
 * attachments) may be linked from outside the workspace, so each module
 * moves its own once its readers are checked.
 */

import { and, asc, eq, gt, isNull, notLike, or } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { files } from '@weldsuite/db/schema';
import {
  PRIVATE_OBJECT_PATH,
  privateObjectUrl,
  workspaceOfKey,
  type StorageBindings,
} from '@weldsuite/worker-kit/storage';

export const MIGRATION_BATCH_SIZE = 25;

export interface MigrationBatchResult {
  /** Rows moved (or that would move, on a dry run). */
  moved: number;
  /** Rows already in the private bucket whose URL was only repointed. */
  repointed: number;
  /** Rows left alone: no key, a key outside this workspace, or no object. */
  skipped: { id: string; reason: 'no-key' | 'foreign-key' | 'missing-object' }[];
  /** Pass back to continue; null when the walk is done. */
  cursor: string | null;
  done: boolean;
}

type RowOutcome = 'moved' | 'repointed' | MigrationBatchResult['skipped'][number]['reason'];

/** Move (or repoint) one row; a dry run only reports what it would do. */
async function migrateRow(
  params: { db: Database; workspaceId: string; apiOrigin: string; dryRun?: boolean },
  buckets: { privateBucket: R2Bucket; publicBucket: R2Bucket },
  row: { id: string; fileKey: string | null; storagePath: string | null; fileName: string },
): Promise<RowOutcome> {
  const { db, workspaceId, apiOrigin } = params;
  const { privateBucket, publicBucket } = buckets;
  const key = row.fileKey || row.storagePath;
  if (!key) return 'no-key';
  if (workspaceOfKey(key) !== workspaceId) return 'foreign-key';

  const alreadyPrivate = await privateBucket.head(key);
  const publicObject = alreadyPrivate ? null : await publicBucket.get(key);
  if (!alreadyPrivate && !publicObject) return 'missing-object';
  const outcome = alreadyPrivate ? 'repointed' : 'moved';
  if (params.dryRun) return outcome;

  if (publicObject) {
    await privateBucket.put(key, publicObject.body, {
      httpMetadata: publicObject.httpMetadata,
      customMetadata: { ...publicObject.customMetadata, fileName: row.fileName },
    });
  }
  await db
    .update(files)
    .set({ url: privateObjectUrl(apiOrigin, key), bucket: 'private' })
    .where(eq(files.id, row.id));
  await publicBucket.delete(key);
  return outcome;
}

export async function migratePrivateFilesBatch(params: {
  db: Database;
  env: StorageBindings;
  workspaceId: string;
  apiOrigin: string;
  cursor?: string | null;
  limit?: number;
  dryRun?: boolean;
}): Promise<MigrationBatchResult> {
  const { db, env } = params;
  const limit = params.limit ?? MIGRATION_BATCH_SIZE;
  if (!env.STORAGE || !env.PRIVATE_STORAGE) throw new Error('Both storage buckets must be bound');
  const buckets = { privateBucket: env.PRIVATE_STORAGE, publicBucket: env.STORAGE };

  const rows = await db
    .select({ id: files.id, fileKey: files.fileKey, storagePath: files.storagePath, fileName: files.fileName })
    .from(files)
    .where(
      and(
        eq(files.isPublic, false),
        isNull(files.entityType),
        or(isNull(files.url), notLike(files.url, `%${PRIVATE_OBJECT_PATH}%`)),
        params.cursor ? gt(files.id, params.cursor) : undefined,
      ),
    )
    .orderBy(asc(files.id))
    .limit(limit);

  const result: MigrationBatchResult = { moved: 0, repointed: 0, skipped: [], cursor: null, done: false };

  for (const row of rows) {
    const outcome = await migrateRow(params, buckets, row);
    if (outcome === 'moved') result.moved++;
    else if (outcome === 'repointed') result.repointed++;
    else result.skipped.push({ id: row.id, reason: outcome });
  }

  // Page by id, so skipped rows and dry runs still make progress.
  const last = rows.at(-1);
  result.cursor = rows.length === limit && last ? last.id : null;
  result.done = result.cursor === null;
  return result;
}
