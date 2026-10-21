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
 * state rather than a dangling pointer.
 *
 * Scheduling follows ADR DATA-008 (nothing opens tenant databases on a timer):
 * the delete routes mark their workspace due in the schedule-index D1
 * (`workspace_due_index`, kind `file_purge`, see lib/file-purge.ts) at the end
 * of the retention window. The daily sweep (see `[triggers]` in wrangler.toml)
 * reads only that index, opens just the due workspaces, purges up to
 * `MAX_BATCHES` batches per table and stores when the next soft-deleted row
 * comes due (or drops the row). A one-time, KV-guarded seed marks every active
 * workspace due once, so files deleted before the index existed are picked up.
 */

import { and, eq, inArray, isNotNull, lt, min, notInArray, or } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import type { Env } from '../types';
import { purgeDueAt, RETENTION_DAYS } from '../lib/file-purge';

export { RETENTION_DAYS };

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const FILE_PURGE_CRONS = ['30 3 * * *'] as const;

export function isFilePurgeCron(cron: string): boolean {
  return (FILE_PURGE_CRONS as readonly string[]).includes(cron);
}

/** KV flag: active workspaces were seeded into the due index. Bump to reseed. */
export const FILE_PURGE_SEED_KEY = 'flow:file-purge-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
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

/**
 * When the workspace next has a soft-deleted file reach the end of retention
 * (null: nothing soft-deleted is left). Re-derived from the tenant after every
 * purge, so the index never drifts from what is actually waiting.
 */
export async function nextPurgeDueAt(db: Database): Promise<Date | null> {
  const [fromProjectFiles] = await db
    .select({ at: min(projectFiles.deletedAt) })
    .from(projectFiles)
    .where(isNotNull(projectFiles.deletedAt));
  const [fromFiles] = await db
    .select({ at: min(files.deletedAt) })
    .from(files)
    .where(and(isNotNull(files.deletedAt), inArray(files.entityType, ['project', 'task'])));
  const earliest = [fromProjectFiles?.at, fromFiles?.at]
    .filter((at): at is Date => at instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return earliest ? purgeDueAt(earliest) : null;
}

/** The Clerk org ids of every active workspace (the one-time seed only). */
async function listActiveWorkspaceOrgIds(env: Env): Promise<string[]> {
  const rows = await getMasterDb(env)
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(and(eq(masterSchema.workspaces.isActive, true), isNotNull(masterSchema.workspaces.clerkOrgId)));
  return rows.map((r) => r.clerkOrgId).filter((id): id is string => !!id);
}

/**
 * Daily purge tick: opens only the workspaces the `file_purge` due index lists
 * as due, never a tenant that is not listed.
 */
export async function runDeletedFilesPurge(
  env: Env,
  now: Date = new Date(),
): Promise<DueIndexSweepResult & PurgeResult> {
  const total: PurgeResult = { rows: 0, objects: 0 };
  if (!env.STORAGE) {
    console.warn('[FilePurge] STORAGE binding missing — skipping sweep');
    return { due: 0, processed: 0, failed: 0, seeded: 0, ...total };
  }
  // Purged objects may sit in either bucket (TASK-620): delete from both.
  const buckets = [env.STORAGE, env.PRIVATE_STORAGE].filter((b): b is R2Bucket => !!b);
  const store: ObjectStore = {
    delete: async (keys) => {
      await Promise.all(buckets.map((b) => b.delete(keys)));
    },
  };
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'file_purge',
    label: '[FilePurge]',
    seed: { key: FILE_PURGE_SEED_KEY, listWorkspaces: () => listActiveWorkspaceOrgIds(env) },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId) => {
      const db = (await getTenantDbForWorkspace(env, orgId)) as unknown as Database;
      const done = await purgeDeletedFiles(db, store, cutoff);
      total.rows += done.rows;
      total.objects += done.objects;
      return nextPurgeDueAt(db);
    },
  });
  if (result.due > 0 || result.failed > 0) {
    console.log(
      `[FilePurge] due=${result.due} processed=${result.processed} failed=${result.failed}: ${total.rows} rows, ${total.objects} objects purged`,
    );
  }
  return { ...result, ...total };
}
