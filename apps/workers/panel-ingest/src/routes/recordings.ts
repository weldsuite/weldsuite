/**
 * `POST /r` (one recording chunk) and `POST /snap` (one masked page snapshot
 * for a heatmap background): gzip bodies from the browser SDK, stored in the
 * private EU replays bucket (ADR PANEL-005). Same shape as `POST /e`: what can
 * be decided from the request is decided before the answer, malformed gets an
 * error, and anything we choose not to keep (paused project, wrong origin,
 * bot, filtered IP, quota, recordings off) is a 204, so the SDK never retries.
 * The storing runs in `waitUntil`.
 *
 * Without the `PANEL_REPLAYS` bucket the feature is off: one warning, 204.
 */

import { Hono, type Context } from 'hono';
import { heatmapSnapshotKey } from '@weldsuite/panel-domain/replays';
import {
  isAllowedOrigin,
  PAGE_GROUP_ID,
  parseSnapshotRequest,
  snapshotRequestKvKey,
  type PanelProjectRecord,
} from '@weldsuite/panel-domain/registry';
import { isDeviceClass, type DeviceClass } from '@weldsuite/panel-domain/device-class';
import type { Env } from '../env';
import { readBytesLimited } from '../lib/body';
import { matchesIpFilter } from '../lib/ip-filter';
import { loadProject } from '../lib/project';
import { quotaState } from '../lib/quota';
import { rateLimited } from '../lib/rate-limit';
import { storeChunk, storeSnapshot, type ChunkParams } from '../lib/replays';
import { isBotUserAgent } from '../lib/user-agent';
import { warnOnce } from '../lib/warn';

type BlobContext = Context<{ Bindings: Env }>;

/** A chunk or snapshot is at most this many compressed bytes. */
export const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_SEQ = 100_000;
const SESSION_ID = /^[\w-]{1,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

type ErrorStatus = 400 | 404 | 413 | 429;

function reject(c: BlobContext, status: ErrorStatus, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

/** A non-negative whole number from a query value; null for anything else (`1e3`, ` 5`, `-1`). */
function wholeNumber(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** Gzip streams start with 1f 8b: a cheap check that the body is what the route says, without inflating it. */
function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

interface Accepted {
  project: PanelProjectRecord;
  bytes: Uint8Array;
}

/**
 * What both routes share, after their own query checks: the rate limit has
 * been applied; this reads the body, finds the project and applies the drops.
 * Returns a Response to answer with, or the project and body to store.
 */
async function accept(c: BlobContext, token: string): Promise<Response | Accepted> {
  const bytes = await readBytesLimited(c.req.raw, MAX_BLOB_BYTES);
  if (bytes === null) return reject(c, 413, 'payload_too_large', `A body is at most ${MAX_BLOB_BYTES} bytes`);
  if (!looksGzipped(bytes)) return reject(c, 400, 'invalid_body', 'The body is not gzip');

  const project = await loadProject(c.env, token);
  if (!project) return reject(c, 404, 'unknown_project', 'Unknown project token');

  const ip = c.req.header('CF-Connecting-IP') ?? '';
  const cf = c.req.raw.cf as IncomingRequestCfProperties | undefined;
  const dropped =
    !isAllowedOrigin(c.req.header('Origin') ?? null, project.allowedDomains) ||
    project.status === 'paused' ||
    isBotUserAgent(c.req.header('User-Agent') ?? '') ||
    cf?.botManagement?.verifiedBot === true ||
    matchesIpFilter(ip, project.settings.ipFilters) ||
    !(project.settings.recordingSampleRate > 0) ||
    (await quotaState(c.env.WORKSPACE_CACHE, project.workspaceId, Date.now())) !== 'ok';
  if (dropped) return c.body(null, 204);

  if (!c.env.PANEL_REPLAYS) {
    warnOnce('binding:PANEL_REPLAYS', 'PANEL_REPLAYS is not bound: recordings and heatmap snapshots are off');
    return c.body(null, 204);
  }
  return { project, bytes };
}

export const recordingRoutes = new Hono<{ Bindings: Env }>();

recordingRoutes.post('/r', async (c) => {
  if (await rateLimited(c.env.REPLAYS_RATE_LIMIT, c.req.header('CF-Connecting-IP') ?? '')) {
    c.header('Retry-After', '10');
    return reject(c, 429, 'rate_limited', 'Too many requests');
  }

  const query = c.req.query();
  const sessionId = query.s;
  const seq = wholeNumber(query.q);
  const start = wholeNumber(query.a);
  const end = wholeNumber(query.b);
  const full = query.f;
  if (!query.t) return reject(c, 400, 'invalid_request', 't: the project token is required');
  if (!sessionId || !SESSION_ID.test(sessionId)) return reject(c, 400, 'invalid_request', 's: not a session id');
  if (seq === null || seq > MAX_SEQ) return reject(c, 400, 'invalid_request', `q: a whole number from 0 to ${MAX_SEQ}`);
  if (start === null || end === null || end < start) return reject(c, 400, 'invalid_request', 'a, b: millisecond times, b not before a');
  if (full !== '0' && full !== '1') return reject(c, 400, 'invalid_request', 'f: 0 or 1');

  const accepted = await accept(c, query.t);
  if (accepted instanceof Response) return accepted;

  const receivedAt = Date.now();
  // The client clock decides these only as far as a session's times can: kept inside a believable window.
  const clamp = (ms: number) => Math.min(Math.max(ms, receivedAt - 7 * DAY_MS), receivedAt + 60 * 1000);
  const params: ChunkParams = {
    sessionId,
    seq,
    tsStart: clamp(start),
    tsEnd: clamp(end),
    hasFullSnapshot: full === '1',
    receivedAt,
  };
  c.executionCtx.waitUntil(storeChunk(c.env, accepted.project, params, accepted.bytes));
  return c.body(null, 204);
});

recordingRoutes.post('/snap', async (c) => {
  if (await rateLimited(c.env.SNAPSHOTS_RATE_LIMIT, c.req.header('CF-Connecting-IP') ?? '')) {
    c.header('Retry-After', '10');
    return reject(c, 429, 'rate_limited', 'Too many requests');
  }

  const query = c.req.query();
  const pageGroupId = query.g;
  const deviceClass = query.d;
  if (!query.t) return reject(c, 400, 'invalid_request', 't: the project token is required');
  if (!pageGroupId || !PAGE_GROUP_ID.test(pageGroupId)) return reject(c, 400, 'invalid_request', 'g: not a page group id');
  if (!isDeviceClass(deviceClass)) return reject(c, 400, 'invalid_request', 'd: desktop, tablet or mobile');

  const accepted = await accept(c, query.t);
  if (accepted instanceof Response) return accepted;

  c.executionCtx.waitUntil(acceptSnapshot(c.env, accepted, pageGroupId, deviceClass));
  return c.body(null, 204);
});

/**
 * Stores the snapshot only if the project asked for exactly this page group
 * and device class: the project token is public, so without the request in KV
 * anyone could overwrite a heatmap background. Once stored the request is
 * deleted (if it still is the one answered), so visitors stop being asked.
 */
async function acceptSnapshot(env: Env, accepted: Accepted, pageGroupId: string, deviceClass: DeviceClass): Promise<void> {
  const { project, bytes } = accepted;
  try {
    const key = snapshotRequestKvKey(project.projectId);
    const raw = await env.WORKSPACE_CACHE.get(key);
    const request = parseSnapshotRequest(raw);
    if (!request || request.pageGroupId !== pageGroupId || request.deviceClass !== deviceClass) return;

    await storeSnapshot(env, heatmapSnapshotKey({ workspaceId: project.workspaceId, projectId: project.projectId, pageGroupId, deviceClass }), bytes);
    if ((await env.WORKSPACE_CACHE.get(key)) === raw) await env.WORKSPACE_CACHE.delete(key);
  } catch (error) {
    console.error(`[panel-ingest] Snapshot write failed for project ${project.projectId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
