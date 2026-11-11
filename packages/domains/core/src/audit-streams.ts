/**
 * Audit log streams: pushing a workspace's audit events to its SIEM (Splunk
 * HEC or any HTTPS collector that takes JSON).
 *
 * `audit-log-worker` calls `flushAuditLogStreams` a few seconds after it has
 * written a batch of audit rows (see the settle window below); app-api's
 * `POST /api/audit-log-streams/:id/test` calls `sendAuditLogStreamTest`,
 * which the window does not concern. Delivery reads `audit_logs` forward
 * from the stream's cursor, so it is ordered and at-least-once: the cursor
 * moves only after a 2xx, a failed batch is sent again, and a destination
 * that was down catches up. Two flushes of one workspace at the same time can
 * deliver a batch twice (the cursor update is compare-and-swap, so it never
 * goes back).
 *
 * The cursor `(cursorCreatedAt, cursorId)` is a JS `Date`, which has
 * milliseconds, while `audit_logs.created_at` is a Postgres `timestamp` with
 * microseconds. Comparing a truncated cursor against the full value would
 * select the row the cursor stands on again and again, so rows are compared
 * and ordered on `date_trunc('milliseconds', created_at)` and then `id`; an
 * index-friendly `created_at >= cursor` prefilter narrows the scan first.
 *
 * A cursor over `created_at` is only safe over rows that can no longer gain
 * an older neighbour. `created_at` is the database's `now()`, the time the
 * insert's transaction started, not the time it committed, and the audit
 * consumer writes from several invocations at once: a row can become visible
 * after a later one (or, inside one millisecond, after one with a higher id)
 * was already sent, and a cursor that had moved past it would never send it.
 * So a flush reads only rows older than the settle window
 * (`created_at < now - AUDIT_STREAM_SETTLE_MS`): by then every insert that
 * took an earlier timestamp has committed. Younger rows wait for a later
 * flush and the cursor never passes them, which is why the caller flushes a
 * little after the window has passed rather than straight after its writes.
 *
 * Nothing here throws into the caller, and the token never reaches a log, an
 * error excerpt or a result.
 *
 * The two workers use different Drizzle drivers, so the db handle is typed as
 * the driver-agnostic `PgDatabase` (see sso.ts).
 */

import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auditLogStreams, auditLogs } from '@weldsuite/db/schema';
import type { AuditLog, AuditLogStream, AuditLogStreamSettings } from '@weldsuite/db/schema';
import { decryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { checkSafeUrl } from '@weldsuite/worker-kit/safe-url';

export type AuditStreamsDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Rows in one request. */
export const AUDIT_STREAM_BATCH_SIZE = 200;
/** Requests per stream in one flush; the rest waits for the next flush. */
export const AUDIT_STREAM_MAX_REQUESTS_PER_FLUSH = 5;
/** Timeout of one request to the destination. */
export const AUDIT_STREAM_REQUEST_TIMEOUT_MS = 10_000;
/** Consecutive failed deliveries after which the platform switches a stream off. */
export const AUDIT_STREAM_DISABLE_AFTER_FAILURES = 20;
/**
 * How old a row must be before a flush reads it. An insert takes its
 * `created_at` when its transaction starts and shows up when it commits; past
 * this window no row with an earlier `created_at` is still on its way.
 */
export const AUDIT_STREAM_SETTLE_MS = 5_000;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const ERROR_EXCERPT_CHARS = 200;
const DEFAULT_SPLUNK_HOST = 'weldsuite';
const DEFAULT_SPLUNK_SOURCE = 'weldsuite:audit';
const DEFAULT_SPLUNK_SOURCETYPE = '_json';

// ============================================================================
// Event and request builders (pure)
// ============================================================================

/** What is sent for one audit row: no `data` snapshot, no metadata beyond `source`. */
export interface AuditStreamEvent {
  id: string;
  /** ISO 8601, UTC, milliseconds. */
  timestamp: string;
  workspaceId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  actor: { id: string | null; name: string | null };
  source: string | null;
  changes: AuditLog['changes'];
  ipAddress: string | null;
}

export type AuditStreamRow = Pick<
  AuditLog,
  'id' | 'createdAt' | 'entityType' | 'entityId' | 'action' | 'description' | 'changes' | 'performedBy' | 'performedByName' | 'ipAddress' | 'metadata'
>;

function metadataString(metadata: AuditLog['metadata'], key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function buildAuditStreamEvent(row: AuditStreamRow, workspaceId?: string | null): AuditStreamEvent {
  return {
    id: row.id,
    timestamp: row.createdAt.toISOString(),
    workspaceId: metadataString(row.metadata, 'workspaceId') ?? workspaceId ?? null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    description: row.description,
    actor: { id: row.performedBy ?? null, name: row.performedByName ?? null },
    source: metadataString(row.metadata, 'source'),
    changes: row.changes ?? null,
    ipAddress: row.ipAddress ?? null,
  };
}

/** The one synthetic event of "send a test". */
export function buildTestAuditStreamEvent(now: Date, workspaceId?: string | null): AuditStreamEvent {
  return {
    id: 'audit_test',
    timestamp: now.toISOString(),
    workspaceId: workspaceId ?? null,
    action: 'test',
    entityType: 'audit_log_stream',
    entityId: 'audit_log_stream_test',
    description: 'Test event from WeldSuite: this audit log stream is reachable.',
    actor: { id: null, name: 'WeldSuite' },
    source: 'system',
    changes: null,
    ipAddress: null,
  };
}

export type AuditStreamDestination = Pick<AuditLogStream, 'type' | 'url' | 'settings'>;

export interface AuditStreamRequest {
  body: string;
  headers: Record<string, string>;
}

/** Epoch seconds with milliseconds, the HEC `time` field. */
function epochSeconds(iso: string): number {
  return Number((new Date(iso).getTime() / 1000).toFixed(3));
}

/**
 * The request for a batch of events.
 *
 *  - `splunk_hec`: `Authorization: Splunk <token>`, one HEC envelope per event
 *    `{ time, host, source, sourcetype, index?, event }`, joined with newlines.
 *  - `http`: `Content-Type: application/json` and `{ "events": [...] }`, or
 *    with `format: 'ndjson'` one event per line as `application/x-ndjson`; the
 *    token, when there is one, goes in `settings.authHeader ?? 'Authorization'`
 *    exactly as the member typed it (`Bearer …`, `ApiKey …`, a bare key).
 */
export function buildAuditStreamRequest(
  stream: AuditStreamDestination,
  token: string | null,
  events: readonly AuditStreamEvent[],
): AuditStreamRequest {
  const settings: AuditLogStreamSettings = stream.settings ?? {};
  if (stream.type === 'splunk_hec') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Splunk ${token}`;
    const body = events
      .map((event) =>
        JSON.stringify({
          time: epochSeconds(event.timestamp),
          host: settings.host || DEFAULT_SPLUNK_HOST,
          source: settings.source || DEFAULT_SPLUNK_SOURCE,
          sourcetype: settings.sourcetype || DEFAULT_SPLUNK_SOURCETYPE,
          ...(settings.index ? { index: settings.index } : {}),
          event,
        }),
      )
      .join('\n');
    return { body, headers };
  }

  const ndjson = settings.format === 'ndjson';
  const headers: Record<string, string> = { 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' };
  if (token) headers[settings.authHeader || 'Authorization'] = token;
  const body = ndjson ? events.map((event) => JSON.stringify(event)).join('\n') : JSON.stringify({ events });
  return { body, headers };
}

/** Wait after the Nth consecutive failure: `min(60 s × 2^failures, 1 h)`. */
export function auditStreamBackoffMs(consecutiveFailures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures, 30), BACKOFF_MAX_MS);
}

// ============================================================================
// Sending
// ============================================================================

export interface AuditStreamSendOptions {
  keyring: EncryptionKeyring;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Skip the private-network URL check (tests, self-hosted installs that collect on their own network). */
  allowPrivateNetworks?: boolean;
}

export interface AuditStreamSendResult {
  ok: boolean;
  status: number | null;
  /** Short and free of the token; null when ok. */
  error: string | null;
  durationMs: number;
}

/** Remove the token from text that came from the destination or the network stack. */
function scrub(text: string, token: string | null): string {
  let out = text;
  if (token) out = out.split(token).join('***');
  return out.replaceAll(/\s+/g, ' ').trim().slice(0, ERROR_EXCERPT_CHARS);
}

function failureOf(err: unknown, token: string | null): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `Timed out after ${AUDIT_STREAM_REQUEST_TIMEOUT_MS / 1000} s`;
  }
  const message = err instanceof Error ? err.message : '';
  return message ? `Request failed: ${scrub(message, token)}` : 'Request failed';
}

type TokenResult = { ok: true; token: string | null } | { ok: false; error: string };

async function openToken(tokenEncrypted: string | null, keyring: EncryptionKeyring): Promise<TokenResult> {
  if (!tokenEncrypted) return { ok: true, token: null };
  try {
    return { ok: true, token: await decryptField(tokenEncrypted, keyring) };
  } catch {
    return { ok: false, error: 'The stored token cannot be decrypted; enter it again' };
  }
}

/** POST one request; never throws. */
async function post(
  stream: AuditStreamDestination,
  token: string | null,
  events: readonly AuditStreamEvent[],
  options: AuditStreamSendOptions,
): Promise<AuditStreamSendResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  if (!options.allowPrivateNetworks) {
    const safe = checkSafeUrl(stream.url);
    if (!safe.ok) return { ok: false, status: null, error: safe.reason, durationMs: elapsed() };
  }

  const { body, headers } = buildAuditStreamRequest(stream, token, events);
  try {
    const response = await (options.fetch ?? fetch)(stream.url, {
      method: 'POST',
      headers,
      body,
      // A redirect would carry the token to another host: it counts as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(AUDIT_STREAM_REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 200 && response.status < 300) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: true, status: response.status, error: null, durationMs: elapsed() };
    }
    let excerpt = '';
    try {
      excerpt = scrub((await response.text()).slice(0, ERROR_EXCERPT_CHARS * 2), token);
    } catch {
      // The status alone is enough.
    }
    return {
      ok: false,
      status: response.status,
      error: excerpt ? `HTTP ${response.status}: ${excerpt}` : `HTTP ${response.status}`,
      durationMs: elapsed(),
    };
  } catch (err) {
    return { ok: false, status: null, error: failureOf(err, token), durationMs: elapsed() };
  }
}

/**
 * Send one synthetic test event to a destination now. Touches no cursor and
 * no counter; the answer is what app-api returns from `POST /:id/test`.
 */
export async function sendAuditLogStreamTest(
  stream: Pick<AuditLogStream, 'type' | 'url' | 'settings' | 'tokenEncrypted'>,
  options: AuditStreamSendOptions & { now?: Date; workspaceId?: string | null },
): Promise<AuditStreamSendResult> {
  const started = Date.now();
  try {
    const token = await openToken(stream.tokenEncrypted, options.keyring);
    if (!token.ok) return { ok: false, status: null, error: token.error, durationMs: Date.now() - started };
    const event = buildTestAuditStreamEvent(options.now ?? new Date(), options.workspaceId);
    return await post(stream, token.token, [event], options);
  } catch {
    return { ok: false, status: null, error: 'Request failed', durationMs: Date.now() - started };
  }
}

// ============================================================================
// Flushing
// ============================================================================

export interface FlushAuditLogStreamsOptions extends AuditStreamSendOptions {
  /** The time of the flush: rows younger than `now - AUDIT_STREAM_SETTLE_MS` are left for a later one. */
  now?: Date;
  /** Used for events whose row carries no `metadata.workspaceId`. */
  workspaceId?: string | null;
}

export interface FlushStreamResult {
  streamId: string;
  /** `idle`: nothing to send; `backoff`: still waiting after a failure. */
  outcome: 'delivered' | 'idle' | 'backoff' | 'failed';
  delivered: number;
  error: string | null;
}

const MS = sql`date_trunc('milliseconds', ${auditLogs.createdAt})`;
/** The same instant as text, exact to the millisecond: no float or Date rounding on the way to the cursor. */
const MS_TEXT = sql<string>`to_char(date_trunc('milliseconds', ${auditLogs.createdAt}), 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;

interface Cursor {
  at: Date;
  id: string | null;
}

function cursorOf(stream: AuditLogStream): Cursor {
  return { at: stream.cursorCreatedAt ?? stream.createdAt, id: stream.cursorId };
}

/**
 * Rows strictly after the cursor in `(ms(created_at), id)` order, oldest
 * first, that are older than `settledBefore`. That bound is a `Date`, so it
 * falls on a millisecond and never splits the rows of one: a millisecond is
 * read whole or not at all.
 */
async function readBatch(
  db: AuditStreamsDb,
  cursor: Cursor,
  settledBefore: Date,
): Promise<{ row: AuditStreamRow; ms: Date }[]> {
  const at = cursor.at.toISOString();
  const after =
    cursor.id === null
      ? sql`${MS} > ${at}::timestamp`
      : sql`(${MS}, ${auditLogs.id}) > (${at}::timestamp, ${cursor.id})`;
  const rows = await db
    .select({
      id: auditLogs.id,
      createdAt: auditLogs.createdAt,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      action: auditLogs.action,
      description: auditLogs.description,
      changes: auditLogs.changes,
      performedBy: auditLogs.performedBy,
      performedByName: auditLogs.performedByName,
      ipAddress: auditLogs.ipAddress,
      metadata: auditLogs.metadata,
      msText: MS_TEXT,
    })
    .from(auditLogs)
    .where(and(gte(auditLogs.createdAt, cursor.at), lt(auditLogs.createdAt, settledBefore), after))
    .orderBy(asc(MS), asc(auditLogs.id))
    .limit(AUDIT_STREAM_BATCH_SIZE);
  return rows.map(({ msText, ...row }) => ({ row, ms: new Date(`${msText}Z`) }));
}

/** `column IS NOT DISTINCT FROM value`, so a stream that has no cursor id yet matches too. */
function sameCursor(cursor: Cursor, stream: AuditLogStream) {
  const atMatches = stream.cursorCreatedAt
    ? sql`${auditLogStreams.cursorCreatedAt} = ${cursor.at.toISOString()}::timestamp`
    : sql`${auditLogStreams.cursorCreatedAt} IS NULL`;
  const idMatches = cursor.id === null ? sql`${auditLogStreams.cursorId} IS NULL` : eq(auditLogStreams.cursorId, cursor.id);
  return and(eq(auditLogStreams.id, stream.id), atMatches, idMatches);
}

/** Whether a stream that failed is still waiting out its backoff. */
function inBackoff(stream: AuditLogStream, now: Date): boolean {
  if (stream.consecutiveFailures <= 0 || !stream.lastAttemptAt) return false;
  return now.getTime() - stream.lastAttemptAt.getTime() < auditStreamBackoffMs(stream.consecutiveFailures);
}

/** Record a failed delivery; a stream that failed too often in a row is switched off. */
async function recordFailure(
  db: AuditStreamsDb,
  streamId: string,
  failures: number,
  error: string | null,
  now: Date,
): Promise<void> {
  await db
    .update(auditLogStreams)
    .set({
      lastAttemptAt: now,
      lastError: error,
      consecutiveFailures: failures,
      ...(failures >= AUDIT_STREAM_DISABLE_AFTER_FAILURES ? { status: 'disabled' as const } : {}),
      updatedAt: now,
    })
    .where(eq(auditLogStreams.id, streamId));
}

async function flushStream(
  db: AuditStreamsDb,
  stream: AuditLogStream,
  options: FlushAuditLogStreamsOptions,
  now: Date,
): Promise<FlushStreamResult> {
  const result: FlushStreamResult = { streamId: stream.id, outcome: 'idle', delivered: 0, error: null };

  if (inBackoff(stream, now)) return { ...result, outcome: 'backoff' };

  const token = await openToken(stream.tokenEncrypted, options.keyring);
  const settledBefore = new Date(now.getTime() - AUDIT_STREAM_SETTLE_MS);
  let cursor = cursorOf(stream);
  let current = stream;

  for (let request = 0; request < AUDIT_STREAM_MAX_REQUESTS_PER_FLUSH; request++) {
    const batch = await readBatch(db, cursor, settledBefore);
    if (batch.length === 0) break;

    const events = batch.map(({ row }) => buildAuditStreamEvent(row, options.workspaceId));
    const sent = token.ok
      ? await post(stream, token.token, events, options)
      : ({ ok: false, status: null, error: token.error, durationMs: 0 } satisfies AuditStreamSendResult);

    if (!sent.ok) {
      await recordFailure(db, stream.id, current.consecutiveFailures + 1, sent.error, now);
      return { ...result, outcome: 'failed', error: sent.error };
    }

    const last = batch.at(-1)!;
    const next: Cursor = { at: last.ms, id: last.row.id };
    const moved = await db
      .update(auditLogStreams)
      .set({
        cursorCreatedAt: next.at,
        cursorId: next.id,
        lastDeliveredAt: now,
        lastAttemptAt: now,
        lastError: null,
        consecutiveFailures: 0,
        deliveredCount: sql`${auditLogStreams.deliveredCount} + ${batch.length}`,
        updatedAt: now,
      })
      .where(sameCursor(cursor, current))
      .returning({ id: auditLogStreams.id });
    result.outcome = 'delivered';
    result.delivered += batch.length;
    // Another flush moved the cursor under us: leave it to that flush.
    if (moved.length === 0) break;
    cursor = next;
    current = { ...current, cursorCreatedAt: next.at, cursorId: next.id, consecutiveFailures: 0 };
    if (batch.length < AUDIT_STREAM_BATCH_SIZE) break;
  }
  return result;
}

/**
 * Whether the workspace behind `db` has a stream to deliver to: one small
 * query, so a caller can skip the wait for the settle window when there is
 * none. Never throws; a failed query reads as "none" (the streams keep their
 * cursor and catch up on a later flush).
 */
export async function hasActiveAuditLogStreams(db: AuditStreamsDb): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: auditLogStreams.id })
      .from(auditLogStreams)
      .where(eq(auditLogStreams.status, 'active'))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Deliver what has settled in `audit_logs` (rows older than
 * `AUDIT_STREAM_SETTLE_MS`) to every active stream of the workspace behind
 * `db`. A failure of one stream never touches another; nothing throws. Cheap
 * when the workspace has no streams: one small query.
 */
export async function flushAuditLogStreams(
  db: AuditStreamsDb,
  options: FlushAuditLogStreamsOptions,
): Promise<FlushStreamResult[]> {
  const results: FlushStreamResult[] = [];
  let streams: AuditLogStream[];
  try {
    streams = await db.select().from(auditLogStreams).where(eq(auditLogStreams.status, 'active'));
  } catch {
    return results;
  }
  const now = options.now ?? new Date();
  for (const stream of streams) {
    try {
      results.push(await flushStream(db, stream, options, now));
    } catch {
      results.push({ streamId: stream.id, outcome: 'failed', delivered: 0, error: 'Delivery failed' });
    }
  }
  return results;
}
