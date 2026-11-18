/**
 * GDPR erasure of one tracked person (weldsuite-documentation/plans/weldpanel.md "Privacy and GDPR").
 *
 * In order:
 *   1. the PanelProject object forgets the profile and identity links and adds
 *      every id to its `erased` list, which every query excludes from then on;
 *   2. the person's sessions are found in Basin (the object's list no longer
 *      hides them: the lookup runs with an empty exclusion on purpose) and their
 *      recording chunks, plus any `keep/` copy of a favourite, are deleted from R2;
 *   3. the favourites and AI summaries of those sessions are removed, and the set summaries that mention them;
 *   4. the erasure goes to the maintenance worker's queue, which rewrites the
 *      Iceberg rows (and then clears the ids from `erased`).
 *
 * Step 1 comes first because it is what the law asks for "at once", and it is
 * idempotent: erasing an id twice is harmless, so when step 2 fails the caller
 * is told to repeat the request. The message in step 4 is sent even then, so
 * the Iceberg rewrite never depends on R2 being reachable.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { PanelErasureResult } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { projectObjectStub } from '@weldsuite/panel-domain/project-object';
import { eraseMessages } from '@weldsuite/panel-domain/erasure';
import { keepCopyKey } from '@weldsuite/panel-domain/replays';
import {
  createRunner,
  eventsScope,
  lit,
  replayChunksTable,
  resolveRange,
  scopeConds,
  ts,
  type PanelQueryContext,
} from '@weldsuite/panel-domain/query';
import type { Env } from '../types';
import { basinExecutor, QueryUnavailableError } from './query-engine';
import type { QueryRunDeps } from './query-run';
import { chunkKeyBelongs, fullRange, sessionContext } from './recordings';
import { textOf } from './rows';

const { panelSessionFavorites } = schema;

const MAX_SESSIONS = 5000;
const MAX_CHUNK_ROWS = 20000;
const IN_LIST_BATCH = 200;

/** The profile is gone but the recordings could not be cleaned up yet: repeat the request. */
export class ErasureIncompleteError extends Error {
  constructor(
    message: string,
    public readonly result: PanelErasureResult,
  ) {
    super(message);
    this.name = 'ErasureIncompleteError';
  }
}

/** What `lit` refuses (Basin SQL has no bind parameters). A user id may contain a backslash; the maintenance job rewrites those rows by id instead. */
// eslint-disable-next-line no-control-regex
const NOT_QUERYABLE = /[\u0000-\u001f\u007f\\]/;

const inList = (values: readonly string[]) => `(${values.map(lit).join(', ')})`;

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The sessions any of `ids` took part in (as the visitor, the identified user or the distinct id). */
async function sessionsOf(env: Env, base: PanelQueryContext, ids: readonly string[]): Promise<string[]> {
  // No exclusion and no identity join: the ids are erased by now, and the columns named here are on the event itself.
  const ctx: PanelQueryContext = { ...base, erasedIds: [], hasIdentifiedUsers: false };
  const range = resolveRange(fullRange(ctx.now), 'UTC', ctx);
  const scope = eventsScope(ctx, range, range);
  const list = inList(ids);
  const idMatch = `(e.anon_id IN ${list} OR e.distinct_id IN ${list} OR COALESCE(e.user_id, '') IN ${list})`;
  const sql =
    `SELECT DISTINCT e.session_id AS session_id FROM ${scope.from} ` +
    `${scope.where('e.session_id IS NOT NULL', idMatch)} ` +
    `LIMIT ${MAX_SESSIONS}`;
  const [rows = []] = await createRunner(basinExecutor(env)).run([{ name: 'erasure.sessions', sql, columns: ['session_id'] }]);
  return rows.map((row) => textOf(row.session_id)).filter((id) => id !== '');
}

/** The R2 keys of those sessions' chunks, from `replay_chunks_v1`, that belong to the request's workspace and project. */
async function chunkKeysOf(env: Env, ctx: PanelQueryContext, sessionIds: readonly string[]): Promise<string[]> {
  const range = resolveRange(fullRange(ctx.now), 'UTC', ctx);
  const keys = new Set<string>();
  const runner = createRunner(basinExecutor(env));
  for (const batch of batches(sessionIds, IN_LIST_BATCH)) {
    const conds = [...scopeConds(ctx), `ts_start >= ${ts(range.floor)}`, `ts_start <= ${ts(range.now)}`, `session_id IN ${inList(batch)}`];
    const [rows = []] = await runner.run([
      {
        name: 'erasure.chunks',
        sql: `SELECT r2_key FROM ${replayChunksTable} WHERE ${conds.join(' AND ')} LIMIT ${MAX_CHUNK_ROWS}`,
        columns: ['r2_key'],
      },
    ]);
    for (const row of rows) {
      const key = textOf(row.r2_key);
      if (chunkKeyBelongs(key, ctx.workspaceId, ctx.projectId)) keys.add(key);
      else console.warn(`[panel-api] erasure skipped a chunk row with a foreign or malformed key (project ${ctx.projectId})`);
    }
  }
  return [...keys];
}

async function deleteKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (const batch of batches(keys, 1000)) await bucket.delete(batch);
}

async function deleteFavorites(db: Database, projectId: string, sessionIds: readonly string[]): Promise<void> {
  for (const batch of batches(sessionIds, 500)) {
    await db.delete(panelSessionFavorites).where(and(eq(panelSessionFavorites.projectId, projectId), inArray(panelSessionFavorites.sessionId, batch)));
  }
}

/**
 * The AI summaries that quote the sessions: the sessions' own, and the project's set summaries
 * whose themes (session ids, descriptions) mention any of them. A set summary is cheap to make
 * again; one that outlives the erasure is personal data.
 */
async function deleteAiSummaries(db: Database, projectId: string, sessionIds: readonly string[]): Promise<void> {
  const { panelAiSummaries } = schema;
  for (const batch of batches(sessionIds, 500)) {
    await db
      .delete(panelAiSummaries)
      .where(and(eq(panelAiSummaries.projectId, projectId), eq(panelAiSummaries.scope, 'session'), inArray(panelAiSummaries.sessionId, batch)));
  }
  const sets = await db
    .select({ id: panelAiSummaries.id, summary: panelAiSummaries.summary })
    .from(panelAiSummaries)
    .where(and(eq(panelAiSummaries.projectId, projectId), eq(panelAiSummaries.scope, 'set')));
  const doomed = sets.filter((row) => {
    const text = JSON.stringify(row.summary);
    return sessionIds.some((id) => text.includes(JSON.stringify(id).slice(1, -1)));
  });
  for (const batch of batches(doomed.map((row) => row.id), 500)) {
    await db.delete(panelAiSummaries).where(and(eq(panelAiSummaries.projectId, projectId), inArray(panelAiSummaries.id, batch)));
  }
}

async function enqueue(env: Env, workspaceId: string, projectId: string, ids: string[]): Promise<void> {
  if (!env.PANEL_MAINTENANCE) {
    console.warn('[panel-api] PANEL_MAINTENANCE is not bound: the Iceberg rewrite for an erasure was not queued');
    return;
  }
  // At most PANEL_ERASE_MAX_IDS ids per message: the consumer drops anything larger.
  for (const message of eraseMessages({ workspaceId, projectId, ids })) {
    await env.PANEL_MAINTENANCE.send(message);
  }
}

export async function erasePerson(deps: QueryRunDeps, projectId: string, distinctId: string): Promise<PanelErasureResult> {
  const { env, tenantDb, workspaceId } = deps;
  if (!env.PANEL_PROJECT) throw new QueryUnavailableError('People are not configured here');

  // 1. At once, and the only step the law's "without undue delay" cannot wait for.
  const erasure = await projectObjectStub(env.PANEL_PROJECT, projectId).erase({ workspaceId, projectId, userIdOrAnonId: distinctId });
  const ids = [...new Set([distinctId, ...erasure.erasedIds])];
  const result: PanelErasureResult = { userId: erasure.userId, erasedIdCount: ids.length, recordingChunksDeleted: 0 };

  // 2-3. Recordings. A project without the bucket or without Basin configured has no recordings to delete.
  let failure: unknown = null;
  try {
    if (env.PANEL_REPLAYS) {
      const ctx = await sessionContext(deps, projectId);
      const queryable = ids.filter((id) => !NOT_QUERYABLE.test(id));
      const sessionIds = queryable.length > 0 ? await sessionsOf(env, ctx, queryable) : [];
      if (sessionIds.length > 0) {
        const keys = await chunkKeysOf(env, ctx, sessionIds);
        // Originals and the `keep/` copies a favourite has: deleting a key that is not there is a no-op.
        await deleteKeys(env.PANEL_REPLAYS, [...keys, ...keys.map(keepCopyKey)]);
        result.recordingChunksDeleted = keys.length;
        await deleteFavorites(tenantDb, projectId, sessionIds);
        await deleteAiSummaries(tenantDb, projectId, sessionIds);
      }
    }
  } catch (err) {
    if (err instanceof QueryUnavailableError) console.warn('[panel-api] erasure: Basin is not configured, recordings were not looked up');
    else failure = err;
  }

  // 4. The Iceberg rewrite, whatever happened to the recordings.
  try {
    await enqueue(env, workspaceId, projectId, ids);
  } catch (err) {
    console.error('[panel-api] erasure: the maintenance message was not sent', err);
    failure ??= err;
  }

  if (failure) {
    console.error('[panel-api] erasure incomplete', failure);
    throw new ErasureIncompleteError('The profile was erased, but its recordings could not be fully removed yet. Repeat the request.', result);
  }
  return result;
}
