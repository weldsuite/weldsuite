/**
 * Heatmap page groups (`panel_heatmap_pages`) and the snapshot a heat layer is
 * drawn on (docs/plans/weldpanel.md "Heatmaps").
 *
 * The snapshot is one masked rrweb full snapshot (gzip of the FullSnapshot
 * event) per page group and device class, in the private replays bucket. In
 * order:
 *   1. the stored one (`snapshots/<ws>/<project>/<group>/<device>.json.gz`),
 *      written by the collector's `/snap` or an earlier look;
 *   2. otherwise the full snapshot of a recent recording that started on a page
 *      of the group at that device class (found in Basin, read from R2, cut out
 *      of its chunk);
 *   3. otherwise a request in KV (`panel:snapshot-request:<project>`) that
 *      `/c/:token` hands to the next consented visitor's SDK, and "requested".
 * Only one request is pending per project: a newer one replaces it.
 */

import { asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelHeatmapPage } from '@weldsuite/db/schema';
import type { PanelDeviceClass } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type {
  CreatePanelHeatmapPageInput,
  PanelHeatmapPageDto,
  UpdatePanelHeatmapPageInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { MOBILE_MAX_WIDTH, TABLET_MAX_WIDTH } from '@weldsuite/panel-domain/device-class';
import { snapshotRequestKvKey, type PanelSnapshotRequest } from '@weldsuite/panel-domain/registry';
import { heatmapSnapshotKey } from '@weldsuite/panel-domain/replays';
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
import { basinExecutor } from './query-engine';
import type { QueryRunDeps } from './query-run';
import { chunkKeyBelongs, sessionContext } from './recordings';
import { isoOf, textOf } from './rows';

const { panelHeatmapPages } = schema;

/** How long a snapshot request waits for a visitor on a matching page. */
export const SNAPSHOT_REQUEST_TTL_SECONDS = 3 * 24 * 60 * 60;
const CANDIDATE_SESSIONS = 30;

// ---------------------------------------------------------------------------
// Page groups
// ---------------------------------------------------------------------------

export function toHeatmapPageDto(row: PanelHeatmapPage): PanelHeatmapPageDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    urlPattern: row.urlPattern,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The payload of a `panel_heatmap_page` entity event. */
export function heatmapPageEventData(row: PanelHeatmapPage) {
  return { id: row.id, projectId: row.projectId, name: row.name, urlPattern: row.urlPattern };
}

export async function listHeatmapPages(db: Database, projectId: string): Promise<PanelHeatmapPage[]> {
  return db
    .select()
    .from(panelHeatmapPages)
    .where(eq(panelHeatmapPages.projectId, projectId))
    .orderBy(asc(panelHeatmapPages.name), asc(panelHeatmapPages.id));
}

export async function getHeatmapPage(db: Database, id: string): Promise<PanelHeatmapPage | null> {
  const [row] = await db.select().from(panelHeatmapPages).where(eq(panelHeatmapPages.id, id)).limit(1);
  return row ?? null;
}

export async function createHeatmapPage(db: Database, input: CreatePanelHeatmapPageInput, userId: string): Promise<PanelHeatmapPage> {
  const [row] = await db
    .insert(panelHeatmapPages)
    .values({ id: generateId('pnh'), projectId: input.projectId, name: input.name, urlPattern: input.urlPattern, createdByUserId: userId })
    .returning();
  if (!row) throw new Error('panel_heatmap_pages insert returned no row');
  return row;
}

export async function updateHeatmapPage(db: Database, id: string, patch: UpdatePanelHeatmapPageInput): Promise<PanelHeatmapPage | null> {
  const [row] = await db
    .update(panelHeatmapPages)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.urlPattern !== undefined && { urlPattern: patch.urlPattern }),
      updatedAt: new Date(),
    })
    .where(eq(panelHeatmapPages.id, id))
    .returning();
  return row ?? null;
}

export async function deleteHeatmapPage(db: Database, id: string): Promise<PanelHeatmapPage | null> {
  const [row] = await db.delete(panelHeatmapPages).where(eq(panelHeatmapPages.id, id)).returning();
  return row ?? null;
}

/** A page group's stored snapshots and a pending request for it go with it. */
export async function dropSnapshots(env: Env, workspaceId: string, page: Pick<PanelHeatmapPage, 'id' | 'projectId'>): Promise<void> {
  if (env.PANEL_REPLAYS) {
    const keys = (['desktop', 'tablet', 'mobile'] as const).map((deviceClass) =>
      heatmapSnapshotKey({ workspaceId, projectId: page.projectId, pageGroupId: page.id, deviceClass }),
    );
    await env.PANEL_REPLAYS.delete(keys);
  }
  try {
    const key = snapshotRequestKvKey(page.projectId);
    const pending = await env.WORKSPACE_CACHE.get(key, 'json');
    if (pending && typeof pending === 'object' && (pending as Partial<PanelSnapshotRequest>).pageGroupId === page.id) {
      await env.WORKSPACE_CACHE.delete(key);
    }
  } catch (err) {
    console.warn('[panel-api] could not clear a snapshot request', err);
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** rrweb's `FullSnapshot` event type. */
const FULL_SNAPSHOT = 2;

/** The first FullSnapshot event in a chunk's JSON (an array of rrweb events), gzipped the way `/snap` stores one. Null when there is none. */
export async function fullSnapshotFromChunk(chunk: ArrayBuffer): Promise<ArrayBuffer | null> {
  let events: unknown;
  try {
    events = JSON.parse(await gunzip(chunk));
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  const full = events.find((event): event is Record<string, unknown> => !!event && typeof event === 'object' && (event as { type?: unknown }).type === FULL_SNAPSHOT);
  return full ? gzip(JSON.stringify(full)) : null;
}

function deviceCondition(deviceClass: PanelDeviceClass): string {
  if (deviceClass === 'mobile') return `e.viewport_w < ${MOBILE_MAX_WIDTH}`;
  if (deviceClass === 'tablet') return `(e.viewport_w >= ${MOBILE_MAX_WIDTH} AND e.viewport_w < ${TABLET_MAX_WIDTH})`;
  return `(e.viewport_w IS NULL OR e.viewport_w >= ${TABLET_MAX_WIDTH})`;
}

export interface SnapshotCandidate {
  sessionId: string;
  /** When the session first opened a page of the group. */
  visitedAt: string;
}

export interface FullSnapshotChunk {
  sessionId: string;
  tsStart: string;
  r2Key: string;
}

/**
 * Per visit (newest first), the latest full-snapshot chunk that started no
 * later than the visit's first matching page view (plus a few seconds): the
 * snapshot of that page. A session whose snapshots all came after, or that has
 * none, is skipped.
 */
export function pickSnapshotChunks(candidates: readonly SnapshotCandidate[], chunks: readonly FullSnapshotChunk[], slackMs = 5000): FullSnapshotChunk[] {
  const picked: FullSnapshotChunk[] = [];
  for (const candidate of candidates) {
    const visited = Date.parse(candidate.visitedAt);
    const best = chunks
      .filter((chunk) => chunk.sessionId === candidate.sessionId && Date.parse(chunk.tsStart) <= visited + slackMs)
      .sort((a, b) => Date.parse(b.tsStart) - Date.parse(a.tsStart))[0];
    if (best) picked.push(best);
  }
  return picked;
}

/** The sessions that opened a page of the group at that device class lately, newest first (one statement), and their full-snapshot chunks (a second). */
async function findSnapshotChunks(env: Env, ctx: PanelQueryContext, pattern: string, deviceClass: PanelDeviceClass): Promise<FullSnapshotChunk[]> {
  const range = resolveRange({ preset: '30d' }, 'UTC', ctx);
  const scope = eventsScope(ctx, range, range);
  const runner = createRunner(basinExecutor(env));
  const likePattern = lit(pattern.split('*').map((part) => part.replace(/[!%_]/g, (ch) => '!' + ch)).join('%'));
  const visitWhere = scope.where(
    `e.name = ${lit('$pageview')}`,
    'e.session_id IS NOT NULL',
    `e.path LIKE ${likePattern} ESCAPE '!'`,
    deviceCondition(deviceClass),
  );
  const [visits = []] = await runner.run([
    {
      name: 'heatmaps.snapshot.visits',
      sql:
        `SELECT e.session_id AS session_id, MIN(e.ts) AS visited_at FROM ${scope.from} ` +
        `${visitWhere} ` +
        `GROUP BY e.session_id ORDER BY MIN(e.ts) DESC LIMIT ${CANDIDATE_SESSIONS}`,
      columns: ['session_id', 'visited_at'],
    },
  ]);
  const candidates: SnapshotCandidate[] = visits
    .map((row) => ({ sessionId: textOf(row.session_id), visitedAt: isoOf(row.visited_at) }))
    .filter((c) => c.sessionId !== '' && c.visitedAt !== '');
  if (candidates.length === 0) return [];

  const conds = [
    ...scopeConds(ctx),
    `ts_start >= ${ts(range.floor)}`,
    `ts_start <= ${ts(range.now)}`,
    'has_full_snapshot = true',
    `session_id IN (${candidates.map((c) => lit(c.sessionId)).join(', ')})`,
  ];
  const [rows = []] = await runner.run([
    {
      name: 'heatmaps.snapshot.chunks',
      sql: `SELECT session_id, ts_start, r2_key FROM ${replayChunksTable} WHERE ${conds.join(' AND ')} ORDER BY ts_start DESC LIMIT ${CANDIDATE_SESSIONS * 20}`,
      columns: ['session_id', 'ts_start', 'r2_key'],
    },
  ]);
  const chunks: FullSnapshotChunk[] = rows
    .map((row) => ({ sessionId: textOf(row.session_id), tsStart: isoOf(row.ts_start), r2Key: textOf(row.r2_key) }))
    .filter((chunk) => chunkKeyBelongs(chunk.r2Key, ctx.workspaceId, ctx.projectId));
  return pickSnapshotChunks(candidates, chunks);
}

export type SnapshotResult =
  | { status: 'found'; body: ArrayBuffer; source: 'stored' | 'recording' }
  | { status: 'requested' }
  | { status: 'unavailable' };

/** A recent recording's full snapshot for the page group, or null. Looks at a few chunks, newest first. */
async function snapshotFromRecording(deps: QueryRunDeps, projectId: string, pattern: string, deviceClass: PanelDeviceClass): Promise<ArrayBuffer | null> {
  const bucket = deps.env.PANEL_REPLAYS;
  if (!bucket) return null;
  const ctx = await sessionContext(deps, projectId);
  for (const chunk of (await findSnapshotChunks(deps.env, ctx, pattern, deviceClass)).slice(0, 5)) {
    const object = await bucket.get(chunk.r2Key);
    if (!object) continue;
    const snapshot = await fullSnapshotFromChunk(await object.arrayBuffer());
    if (snapshot) return snapshot;
  }
  return null;
}

/** Asks the next consented visitor on a matching page for a snapshot (replaces any pending request of the project). */
export async function requestSnapshot(env: Env, page: PanelHeatmapPage, deviceClass: PanelDeviceClass): Promise<void> {
  const request: PanelSnapshotRequest = { pageGroupId: page.id, urlPattern: page.urlPattern, deviceClass };
  await env.WORKSPACE_CACHE.put(snapshotRequestKvKey(page.projectId), JSON.stringify(request), { expirationTtl: SNAPSHOT_REQUEST_TTL_SECONDS });
}

export async function resolveSnapshot(deps: QueryRunDeps, page: PanelHeatmapPage, deviceClass: PanelDeviceClass): Promise<SnapshotResult> {
  const { env, workspaceId } = deps;
  const bucket = env.PANEL_REPLAYS;
  if (!bucket) return { status: 'unavailable' };

  const key = heatmapSnapshotKey({ workspaceId, projectId: page.projectId, pageGroupId: page.id, deviceClass });
  const stored = await bucket.get(key);
  if (stored) return { status: 'found', body: await stored.arrayBuffer(), source: 'stored' };

  try {
    const fromRecording = await snapshotFromRecording(deps, page.projectId, page.urlPattern, deviceClass);
    if (fromRecording) return { status: 'found', body: fromRecording, source: 'recording' };
  } catch (err) {
    // Basin down or not configured: ask a visitor instead of failing the page.
    console.warn('[panel-api] looking for a recording to take a heatmap snapshot from failed', err);
  }

  try {
    await requestSnapshot(env, page, deviceClass);
  } catch (err) {
    console.warn('[panel-api] could not write a snapshot request', err);
  }
  return { status: 'requested' };
}
