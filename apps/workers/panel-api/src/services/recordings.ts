/**
 * Recordings: one session's detail (metadata, chunk manifest, timeline
 * markers), the chunk bytes in the private EU bucket, and favourites.
 *
 * There is no session table. A session's metrics are an aggregate over
 * `events_v1` (the `sessions` query kind, filtered to one id), its chunks are
 * rows of `replay_chunks_v1`, and the bytes live in R2 under the `r2_key` the
 * collector wrote. Keys are always read from that row, never rebuilt: a chunk's
 * day is the day the chunk started (ADR PANEL-005).
 *
 * Every R2 key read from Basin is checked against the request's workspace and
 * project before it is touched: the Basin token sees every workspace.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelAiSummary, PanelSessionFavorite } from '@weldsuite/db/schema';
import { sessionsSpecSchema, type ParsedSessionsSpec, type PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type {
  PanelActivityEvent,
  PanelChunkManifestEntry,
  PanelFavoriteDto,
  PanelSessionDetail,
  PanelSessionSummary,
  PanelSessionSummaryDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { projectObjectStub } from '@weldsuite/panel-domain/project-object';
import { keepCopyKey, REPLAY_TIERS } from '@weldsuite/panel-domain/replays';
import {
  activityEventFrom,
  activityQuery,
  createRunner,
  lit,
  replayChunksTable,
  resolveRange,
  runPanelQuery,
  scopeConds,
  ts,
  type PanelQueryContext,
  type PanelSqlQuery,
  type Row,
} from '@weldsuite/panel-domain/query';
import type { Env } from '../types';
import { basinExecutor, buildQueryContext, QueryUnavailableError } from './query-engine';
import type { QueryRunDeps } from './query-run';
import { isoOf, numberOf, textOf } from './rows';

const { panelAiSummaries, panelSessionFavorites } = schema;

/** What the client names a session with: word characters and dashes (the collector's rule). */
export const SESSION_ID = /^[\w-]{1,64}$/;

const MANIFEST_CACHE_SECONDS = 3600;
const MAX_CHUNKS = 5000;
const MAX_MARKERS = 1000;
const OTHER_SESSIONS = 10;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * `<tier>/<workspace>/<project>/<day>/<session>/<seq>.json.gz` and nothing else:
 * the tier is one the collector writes, the workspace and project are the
 * request's, and no segment tries to climb out.
 */
export function chunkKeyBelongs(key: string, workspaceId: string, projectId: string): boolean {
  const parts = key.split('/');
  return (
    parts.length === 6 &&
    (REPLAY_TIERS as readonly string[]).includes(parts[0] as string) &&
    parts[1] === workspaceId &&
    parts[2] === projectId &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function manifestCacheKey(projectId: string, sessionId: string): string {
  return `panel:replay-manifest:${projectId}:${sessionId}`;
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/** A `sessions` spec: also what the compiler needs to build a project's context (erased ids, retention, identity flag). */
export function sessionsSpec(projectId: string, overrides: Record<string, unknown> = {}): ParsedSessionsSpec {
  return sessionsSpecSchema.parse({ kind: 'sessions', projectId, dateRange: { preset: '90d' }, ...overrides });
}

/** `YYYY-MM-DD` of today, UTC. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Everything the plan keeps: a range from long ago, clamped by the compiler to the plan's retention. */
export function fullRange(now: Date = new Date()): { from: string; to: string } {
  return { from: '2020-01-01', to: today(now) };
}

/** The project's query context. `overrides` shape the spec the context is built for (a `cohortId` loads that cohort). */
export async function sessionContext(deps: QueryRunDeps, projectId: string, overrides: Record<string, unknown> = {}): Promise<PanelQueryContext> {
  return buildQueryContext({ ...deps, projectId, spec: sessionsSpec(projectId, overrides) });
}

/** The statements that read `replay_chunks_v1` carry the scope and a time bound like every other. */
export function chunkManifestQuery(ctx: PanelQueryContext, sessionId: string): PanelSqlQuery {
  const range = resolveRange(fullRange(ctx.now), 'UTC', ctx);
  const conds = [...scopeConds(ctx), `ts_start >= ${ts(range.floor)}`, `ts_start <= ${ts(range.now)}`, `session_id = ${lit(sessionId)}`];
  return {
    name: 'recordings.manifest',
    sql: `SELECT seq, ts_start, ts_end, bytes, has_full_snapshot, r2_key FROM ${replayChunksTable} WHERE ${conds.join(' AND ')} ORDER BY seq ASC LIMIT ${MAX_CHUNKS}`,
    columns: ['seq', 'ts_start', 'ts_end', 'bytes', 'has_full_snapshot', 'r2_key'],
  };
}

export interface ChunkRecord extends PanelChunkManifestEntry {
  r2Key: string;
}

/** The manifest from Basin rows: one entry per seq (a re-sent chunk counts once), in order, with keys that belong to the request only. */
export function chunksFromRows(rows: readonly Row[], workspaceId: string, projectId: string): ChunkRecord[] {
  const bySeq = new Map<number, ChunkRecord>();
  for (const row of rows) {
    const r2Key = textOf(row.r2_key);
    if (!chunkKeyBelongs(r2Key, workspaceId, projectId)) {
      console.warn(`[panel-api] ignoring a chunk row with a foreign or malformed key (project ${projectId})`);
      continue;
    }
    const seq = numberOf(row.seq);
    if (bySeq.has(seq)) continue;
    bySeq.set(seq, {
      seq,
      tsStart: isoOf(row.ts_start),
      tsEnd: isoOf(row.ts_end),
      bytes: numberOf(row.bytes),
      hasFullSnapshot: row.has_full_snapshot === true || row.has_full_snapshot === 'true' || row.has_full_snapshot === 1,
      r2Key,
    });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Runs the manifest statement for a session. */
export async function loadChunks(env: Env, ctx: PanelQueryContext, sessionId: string): Promise<ChunkRecord[]> {
  const [rows = []] = await createRunner(basinExecutor(env)).run([chunkManifestQuery(ctx, sessionId)]);
  return chunksFromRows(rows, ctx.workspaceId, ctx.projectId);
}

// ---------------------------------------------------------------------------
// Favourites and summaries (tenant rows)
// ---------------------------------------------------------------------------

export function toFavoriteDto(row: PanelSessionFavorite): PanelFavoriteDto {
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    note: row.note,
    favoritedByUserId: row.favoritedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSessionSummaryDto(row: PanelAiSummary): PanelSessionSummaryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId ?? '',
    summary: row.summary as unknown as PanelSessionSummary,
    modelId: row.modelId,
    creditsCharged: row.creditsCharged,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getFavorite(db: Database, projectId: string, sessionId: string): Promise<PanelSessionFavorite | null> {
  const [row] = await db
    .select()
    .from(panelSessionFavorites)
    .where(and(eq(panelSessionFavorites.projectId, projectId), eq(panelSessionFavorites.sessionId, sessionId)))
    .limit(1);
  return row ?? null;
}

export async function latestSessionSummary(db: Database, projectId: string, sessionId: string): Promise<PanelAiSummary | null> {
  const [row] = await db
    .select()
    .from(panelAiSummaries)
    .where(and(eq(panelAiSummaries.projectId, projectId), eq(panelAiSummaries.scope, 'session'), eq(panelAiSummaries.sessionId, sessionId)))
    .orderBy(desc(panelAiSummaries.createdAt))
    .limit(1);
  return row ?? null;
}

/** Sets `favorite` on session rows from the project's favourites (they are per project, never cached with the data). */
export async function markFavorites(db: Database, projectId: string, sessions: PanelSessionRow[]): Promise<PanelSessionRow[]> {
  if (sessions.length === 0) return sessions;
  const rows = await db
    .select({ sessionId: panelSessionFavorites.sessionId })
    .from(panelSessionFavorites)
    .where(and(eq(panelSessionFavorites.projectId, projectId), inArray(panelSessionFavorites.sessionId, sessions.map((s) => s.sessionId))));
  const favourites = new Set(rows.map((r) => r.sessionId));
  return sessions.map((s) => ({ ...s, favorite: favourites.has(s.sessionId) }));
}

// ---------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------

/** Names that make a marker on the player's timeline besides pages, clicks and custom events. */
const FRUSTRATION = new Set(['$rageclick', '$deadclick', '$quickback', '$excessivescroll']);

/**
 * The events the player marks: pages, clicks and form submits, frustration,
 * errors and custom events. Page leaves, identity links and the other system
 * events are noise on a timeline.
 */
export function isTimelineMarker(event: PanelActivityEvent): boolean {
  if (event.name === '$pageview' || event.name === '$exception' || event.name === '$autocapture' || FRUSTRATION.has(event.name)) return true;
  return !event.name.startsWith('$');
}

/** The session's events oldest first (activity comes newest first), markers only. */
export function markersFrom(rows: readonly Row[]): PanelActivityEvent[] {
  return rows.map(activityEventFrom).filter(isTimelineMarker).reverse();
}

/** The session's row (one id through the `sessions` kind) or null. */
export async function loadSessionRow(env: Env, ctx: PanelQueryContext, sessionId: string, wide: boolean): Promise<PanelSessionRow | null> {
  const spec = sessionsSpec(ctx.projectId, {
    sessionIds: [sessionId],
    limit: 1,
    dateRange: wide ? fullRange(ctx.now) : { preset: '90d' },
  });
  const { result } = await runPanelQuery(spec, ctx, basinExecutor(env));
  return result.kind === 'sessions' ? (result.result.sessions[0] ?? null) : null;
}

/** The session's events, newest first, the way `activityQuery` returns them. */
export function sessionEventsQuery(ctx: PanelQueryContext, sessionId: string, limit: number, wide: boolean): PanelSqlQuery {
  return activityQuery(ctx, { sessionId, limit, days: wide ? 365 : 90, excludeNames: ['$pageleave', '$identify'] });
}

export async function loadSessionDetail(deps: QueryRunDeps, projectId: string, sessionId: string): Promise<PanelSessionDetail | null> {
  const { env, tenantDb } = deps;
  if (!env.PANEL_PROJECT) throw new QueryUnavailableError('Recordings are not configured here');

  const favoriteRow = await getFavorite(tenantDb, projectId, sessionId);
  // A favourite can be older than the 90 days recordings are kept for.
  const wide = favoriteRow !== null;
  const ctx = await sessionContext(deps, projectId);
  const execute = basinExecutor(env);

  const [row, [chunkRows = [], eventRows = []] = []] = await Promise.all([
    loadSessionRow(env, ctx, sessionId, wide),
    createRunner(execute).run([chunkManifestQuery(ctx, sessionId), sessionEventsQuery(ctx, sessionId, MAX_MARKERS, wide)]),
  ]);
  if (!row) return null;

  const stub = projectObjectStub(env.PANEL_PROJECT, projectId);
  const [person, others, summaryRow] = await Promise.all([
    stub.getPerson(row.userId ?? row.distinctId),
    runPanelQuery(sessionsSpec(projectId, { distinctId: row.distinctId, limit: OTHER_SESSIONS + 1 }), ctx, execute),
    latestSessionSummary(tenantDb, projectId, sessionId),
  ]);

  const otherRows =
    others.result.kind === 'sessions' ? others.result.result.sessions.filter((s) => s.sessionId !== sessionId).slice(0, OTHER_SESSIONS) : [];
  const marked = await markFavorites(tenantDb, projectId, [row, ...otherRows]);
  const chunks = chunksFromRows(chunkRows, ctx.workspaceId, projectId);
  await cacheManifest(env, projectId, sessionId, chunks);

  return {
    projectId,
    session: marked[0] ?? row,
    person,
    chunks: chunks.map((chunk) => ({
      seq: chunk.seq,
      tsStart: chunk.tsStart,
      tsEnd: chunk.tsEnd,
      bytes: chunk.bytes,
      hasFullSnapshot: chunk.hasFullSnapshot,
    })),
    events: markersFrom(eventRows),
    favorite: favoriteRow ? toFavoriteDto(favoriteRow) : null,
    summary: summaryRow ? toSessionSummaryDto(summaryRow) : null,
    otherSessions: marked.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Chunk bytes
// ---------------------------------------------------------------------------

async function cacheManifest(env: Env, projectId: string, sessionId: string, chunks: readonly ChunkRecord[]): Promise<void> {
  if (chunks.length === 0) return;
  const keys: Record<string, string> = {};
  for (const chunk of chunks) keys[String(chunk.seq)] = chunk.r2Key;
  try {
    await env.WORKSPACE_CACHE.put(manifestCacheKey(projectId, sessionId), JSON.stringify(keys), { expirationTtl: MANIFEST_CACHE_SECONDS });
  } catch (err) {
    console.warn('[panel-api] replay manifest cache write failed', err);
  }
}

async function cachedKey(env: Env, projectId: string, sessionId: string, seq: number): Promise<string | null> {
  try {
    const hit = await env.WORKSPACE_CACHE.get(manifestCacheKey(projectId, sessionId), 'json');
    if (hit && typeof hit === 'object') {
      const key = (hit as Record<string, unknown>)[String(seq)];
      return typeof key === 'string' ? key : null;
    }
  } catch (err) {
    console.warn('[panel-api] replay manifest cache read failed', err);
  }
  return null;
}

/**
 * The R2 key of one chunk: from the cached manifest (filled when the session
 * detail was opened), else from Basin. Null when the session has no such chunk
 * (or its key belongs to someone else).
 */
export async function chunkKeyFor(deps: QueryRunDeps, projectId: string, sessionId: string, seq: number): Promise<string | null> {
  const { env, workspaceId } = deps;
  const cached = await cachedKey(env, projectId, sessionId, seq);
  if (cached && chunkKeyBelongs(cached, workspaceId, projectId)) return cached;

  const ctx = await sessionContext(deps, projectId);
  const chunks = await loadChunks(env, ctx, sessionId);
  await cacheManifest(env, projectId, sessionId, chunks);
  return chunks.find((chunk) => chunk.seq === seq)?.r2Key ?? null;
}

/**
 * Opens a chunk. A favourite's chunks also sit under `keep/`, which survives
 * the lifecycle rule that removes the original, so a missing original falls
 * back to the copy when the session is a favourite.
 */
export async function openChunk(env: Env, db: Database, projectId: string, sessionId: string, r2Key: string): Promise<R2ObjectBody | null> {
  const bucket = env.PANEL_REPLAYS;
  if (!bucket) return null;
  const original = await bucket.get(r2Key);
  if (original) return original;
  if (!(await getFavorite(db, projectId, sessionId))) return null;
  return bucket.get(keepCopyKey(r2Key));
}

// ---------------------------------------------------------------------------
// Favourite copies
// ---------------------------------------------------------------------------

async function inBatches<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Copies the session's chunks to `keep/`. Chunks already expired are skipped. Returns how many were copied. */
export async function copyChunksToKeep(bucket: R2Bucket, chunks: readonly ChunkRecord[]): Promise<number> {
  let copied = 0;
  await inBatches(chunks, 6, async (chunk) => {
    const object = await bucket.get(chunk.r2Key);
    if (!object) return;
    await bucket.put(keepCopyKey(chunk.r2Key), await object.arrayBuffer(), {
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: { source: chunk.r2Key },
    });
    copied += 1;
  });
  return copied;
}

export async function deleteKeepCopies(bucket: R2Bucket, chunks: readonly ChunkRecord[]): Promise<void> {
  const keys = chunks.map((chunk) => keepCopyKey(chunk.r2Key));
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

export async function upsertFavorite(
  db: Database,
  projectId: string,
  sessionId: string,
  note: string | null,
  userId: string,
): Promise<PanelSessionFavorite> {
  const [row] = await db
    .insert(panelSessionFavorites)
    .values({ id: generateId('pnf'), projectId, sessionId, note, favoritedByUserId: userId })
    .onConflictDoUpdate({ target: [panelSessionFavorites.projectId, panelSessionFavorites.sessionId], set: { note } })
    .returning();
  if (!row) throw new Error('panel_session_favorites upsert returned no row');
  return row;
}

export async function removeFavorite(db: Database, projectId: string, sessionId: string): Promise<PanelSessionFavorite | null> {
  const [row] = await db
    .delete(panelSessionFavorites)
    .where(and(eq(panelSessionFavorites.projectId, projectId), eq(panelSessionFavorites.sessionId, sessionId)))
    .returning();
  return row ?? null;
}
