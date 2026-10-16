/**
 * Purge of soft-deleted WeldFlow files — Cloudflare cron handler (TASK-854).
 *
 * Deleting a project file, a task attachment or a project document only sets
 * `deletedAt`: the row and the R2 object stay forever, so storage grows and
 * "deleted" data is retained. Once a row has been soft-deleted for longer than
 * `RETENTION_DAYS` this sweep removes its R2 object and then the row itself:
 *
 *  - `project_files`            (project file tree, folders included)
 *  - `files` with entityType 'project' or 'task'
 *    (project documents / sheets and task attachments), together with the
 *    rows that hang off the file: `docs`, `document_versions`, `sheets`,
 *    `whiteboards`
 *
 * An R2 object is only deleted when no remaining row still points at its key, and
 * rows are only deleted after their objects, so a failed run leaves a retriable
 * state rather than a dangling pointer. Runs weekly (see `[triggers]` in
 * wrangler.toml); each run handles up to `MAX_BATCHES` batches per table and
 * workspace and picks up the rest next week.
 */

import { and, eq, inArray, isNotNull, lt, notInArray, or } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

/** How long a soft-deleted file stays restorable before it is purged for good. */
export const RETENTION_DAYS = 30;
const BATCH_SIZE = 200;
const MAX_BATCHES = 5;
/** R2 `delete()` accepts up to 1000 keys per call. */
const R2_DELETE_CHUNK = 1000;

/** The slice of an R2 bucket the purge needs (kept narrow so tests can fake it). */
export interface ObjectStore {
  delete(keys: string | string[]): Promise<void>;
}

export interface PurgeResult {
  rows: number;
  objects: number;
}

const { projectFiles, files, docs, documentVersions, sheets, whiteboards } = schema;

function keysOf(row: { fileKey: string | null; storagePath: string }): string[] {
  const keys = new Set<string>();
  if (row.fileKey) keys.add(row.fileKey);
  if (row.storagePath) keys.add(row.storagePath);
  return [...keys];
}

/** Keys (of `candidates`) that a row outside the purge batch still points at. */
async function keysStillReferenced(
  db: Database,
  candidates: string[],
  excluded: { projectFileIds: string[]; fileIds: string[] },
): Promise<Set<string>> {
  const referenced = new Set<string>();
  if (candidates.length === 0) return referenced;

  const projectRows = await db
    .select({ fileKey: projectFiles.fileKey, storagePath: projectFiles.storagePath })
    .from(projectFiles)
    .where(
      and(
        or(inArray(projectFiles.fileKey, candidates), inArray(projectFiles.storagePath, candidates)),
        excluded.projectFileIds.length ? notInArray(projectFiles.id, excluded.projectFileIds) : undefined,
      ),
    );
  const fileRows = await db
    .select({ fileKey: files.fileKey, storagePath: files.storagePath })
    .from(files)
    .where(
      and(
        or(inArray(files.fileKey, candidates), inArray(files.storagePath, candidates)),
        excluded.fileIds.length ? notInArray(files.id, excluded.fileIds) : undefined,
      ),
    );
  for (const row of [...projectRows, ...fileRows]) {
    for (const key of keysOf({ fileKey: row.fileKey, storagePath: row.storagePath ?? '' })) referenced.add(key);
  }
  return referenced;
}

async function deleteObjects(store: ObjectStore, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_CHUNK) {
    await store.delete(keys.slice(i, i + R2_DELETE_CHUNK));
  }
}

/** One batch of `project_files`; returns how many rows and objects went, 0 rows when nothing is due. */
async function purgeProjectFilesBatch(db: Database, store: ObjectStore, cutoff: Date): Promise<PurgeResult> {
  const batch = await db
    .select({
      id: projectFiles.id,
      fileKey: projectFiles.fileKey,
      storagePath: projectFiles.storagePath,
      isFolder: projectFiles.isFolder,
    })
    .from(projectFiles)
    .where(and(isNotNull(projectFiles.deletedAt), lt(projectFiles.deletedAt, cutoff)))
    .limit(BATCH_SIZE);
  if (batch.length === 0) return { rows: 0, objects: 0 };

  const ids = batch.map((r) => r.id);
  const candidates = batch.filter((r) => !r.isFolder).flatMap((r) => keysOf(r));
  const referenced = await keysStillReferenced(db, candidates, { projectFileIds: ids, fileIds: [] });
  const deletable = [...new Set(candidates)].filter((k) => !referenced.has(k));

  await deleteObjects(store, deletable);
  await db.delete(projectFiles).where(inArray(projectFiles.id, ids));
  return { rows: ids.length, objects: deletable.length };
}

/** One batch of project/task `files` rows and their dependents. */
async function purgeFilesBatch(db: Database, store: ObjectStore, cutoff: Date): Promise<PurgeResult> {
  const batch = await db
    .select({ id: files.id, fileKey: files.fileKey, storagePath: files.storagePath })
    .from(files)
    .where(
      and(
        isNotNull(files.deletedAt),
        lt(files.deletedAt, cutoff),
        inArray(files.entityType, ['project', 'task']),
      ),
    )
    .limit(BATCH_SIZE);
  if (batch.length === 0) return { rows: 0, objects: 0 };

  const ids = batch.map((r) => r.id);
  const candidates = batch.flatMap((r) => keysOf({ fileKey: r.fileKey, storagePath: r.storagePath }));
  const referenced = await keysStillReferenced(db, candidates, { projectFileIds: [], fileIds: ids });
  const deletable = [...new Set(candidates)].filter((k) => !referenced.has(k));

  await deleteObjects(store, deletable);
  // Rows that reference files.id go first (foreign keys).
  await db.delete(documentVersions).where(inArray(documentVersions.fileId, ids));
  await db.delete(docs).where(inArray(docs.fileId, ids));
  await db.delete(sheets).where(inArray(sheets.fileId, ids));
  await db.delete(whiteboards).where(inArray(whiteboards.fileId, ids));
  await db.delete(files).where(inArray(files.id, ids));
  return { rows: ids.length, objects: deletable.length };
}

/** Purge everything soft-deleted before `cutoff` in one workspace's tenant DB. */
export async function purgeDeletedFiles(db: Database, store: ObjectStore, cutoff: Date): Promise<PurgeResult> {
  const total: PurgeResult = { rows: 0, objects: 0 };
  for (const purgeBatch of [purgeProjectFilesBatch, purgeFilesBatch]) {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const done = await purgeBatch(db, store, cutoff);
      total.rows += done.rows;
      total.objects += done.objects;
      if (done.rows < BATCH_SIZE) break;
    }
  }
  return total;
}

/** Weekly sweep over every active workspace. */
export async function runDeletedFilesPurge(env: Env, now: Date = new Date()): Promise<PurgeResult> {
  if (!env.STORAGE) {
    console.warn('[FilePurge] STORAGE binding missing — skipping sweep');
    return { rows: 0, objects: 0 };
  }
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(and(eq(masterSchema.workspaces.isActive, true), isNotNull(masterSchema.workspaces.clerkOrgId)));

  const total: PurgeResult = { rows: 0, objects: 0 };
  for (const { clerkOrgId } of workspaces) {
    if (!clerkOrgId) continue;
    try {
      const db = await getTenantDbForWorkspace(env, clerkOrgId);
      const done = await purgeDeletedFiles(db as unknown as Database, env.STORAGE, cutoff);
      total.rows += done.rows;
      total.objects += done.objects;
    } catch (err) {
      console.error(`[FilePurge] Failed workspace ${clerkOrgId}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[FilePurge] Completed: ${total.rows} rows, ${total.objects} objects purged`);
  return total;
}
