/**
 * `POST /v1/track` and `POST /v1/import`: events and profile operations from a
 * customer's server (`@weldsuite/panel-sdk/server`), with a secret key
 * (`Authorization: Bearer wps_<32 hex>`).
 *
 * The key is looked up by the SHA-256 of the secret in KV (`panel:key:<hash>`,
 * written by panel-api, deleted on revoke), like `api_key_registry`: the
 * collector never sees a database. Unlike the browser routes this one answers
 * after the stream accepted the rows, so a server that is told `accepted: n`
 * can rely on it, and a failing stream is a 503 it can retry (the rows carry
 * their `event_id`).
 *
 * A key of a paused project answers like a blocked quota: 200, nothing accepted.
 *
 * Track takes up to 100 events from the last 7 days, import up to 1000 up to
 * five years old; neither takes a time in the future (a minute of clock skew is
 * moved back to now). Events outside the window are counted in `dropped`.
 * Server events get no geo or user-agent enrichment.
 */

import { Hono, type Context } from 'hono';
import { keyKvKey, parseKeyRecord, type PanelKeyRecord } from '@weldsuite/panel-domain/registry';
import { MAX_IMPORT_EVENTS, MAX_TRACK_EVENTS, parseServerBatch } from '@weldsuite/panel-domain/wire';
import type { Env } from '../env';
import { readTextLimited } from '../lib/body';
import { applyServerPeople } from '../lib/profiles';
import { quotaState } from '../lib/quota';
import { touchSeen } from '../lib/seen';
import { buildServerEventRows, IMPORT_MAX_AGE_MS, TRACK_MAX_AGE_MS } from '../lib/server-rows';
import { utcDate } from '../lib/time';

type ServerContext = Context<{ Bindings: Env }>;
type ErrorStatus = 400 | 401 | 413 | 503;

const SECRET_KEY = /^Bearer (wps_[0-9a-f]{32})$/;

interface Endpoint {
  maxEvents: number;
  maxAgeMs: number;
  maxBodyBytes: number;
}

const TRACK: Endpoint = { maxEvents: MAX_TRACK_EVENTS, maxAgeMs: TRACK_MAX_AGE_MS, maxBodyBytes: 1024 * 1024 };
const IMPORT: Endpoint = { maxEvents: MAX_IMPORT_EVENTS, maxAgeMs: IMPORT_MAX_AGE_MS, maxBodyBytes: 8 * 1024 * 1024 };

function reject(c: ServerContext, status: ErrorStatus, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function firstIssue(issues: { path: (string | number)[]; message: string }[]): string {
  const issue = issues[0];
  if (!issue) return 'Invalid batch';
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The key record the `Authorization` header names; null for a missing, malformed, unknown or revoked key. */
async function authenticate(c: ServerContext): Promise<PanelKeyRecord | null> {
  const secret = SECRET_KEY.exec(c.req.header('Authorization') ?? '')?.[1];
  if (!secret) return null;
  return parseKeyRecord(await c.env.WORKSPACE_CACHE.get(keyKvKey(await sha256Hex(secret)), { cacheTtl: 60 }));
}

async function handle(c: ServerContext, endpoint: Endpoint): Promise<Response> {
  const key = await authenticate(c);
  if (!key) return reject(c, 401, 'unauthorized', 'Send a valid secret key as a Bearer token');

  const text = await readTextLimited(c.req.raw, endpoint.maxBodyBytes);
  if (text === null) return reject(c, 413, 'payload_too_large', `A request is at most ${endpoint.maxBodyBytes} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reject(c, 400, 'invalid_body', 'The body is not valid JSON');
  }
  const parsed = parseServerBatch(body, endpoint.maxEvents);
  if (!parsed.ok) return reject(c, 400, 'invalid_batch', firstIssue(parsed.issues));
  const { batch } = parsed;

  const receivedAt = Date.now();
  // A paused project takes nothing, from the server side either: panel-api rewrites
  // every key's record with the project's status when it is paused or resumed.
  if (key.status === 'paused') return c.json({ accepted: 0, dropped: batch.events.length + parsed.dropped });
  // Past the allowance with no wallet to pay for more: accepted from the caller's side, not counted.
  if ((await quotaState(c.env.WORKSPACE_CACHE, key.workspaceId, receivedAt)) === 'events_blocked') {
    return c.json({ accepted: 0, dropped: batch.events.length + parsed.dropped });
  }

  const { rows, dropped: outsideWindow } = buildServerEventRows({
    record: key,
    batch,
    receivedAt,
    maxAgeMs: endpoint.maxAgeMs,
  });

  if (rows.length > 0) {
    try {
      await c.env.PANEL_EVENTS.send(rows);
    } catch (error) {
      console.error(`[panel-ingest] Server event write failed for project ${key.projectId}: ${error instanceof Error ? error.message : String(error)}`);
      return reject(c, 503, 'write_failed', 'The events could not be stored, try again');
    }
  }

  const bookkeeping = Promise.allSettled([
    rows.length > 0
      ? c.env.PANEL_USAGE.get(c.env.PANEL_USAGE.idFromName(key.workspaceId)).add(utcDate(receivedAt), rows.length, key.workspaceId)
      : Promise.resolve(),
    rows.length > 0 ? touchSeen(c.env.WORKSPACE_CACHE, key.projectId, receivedAt) : Promise.resolve(),
    applyServerPeople(c.env, { projectId: key.projectId, workspaceId: key.workspaceId }, batch.people ?? []),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`[panel-ingest] Server bookkeeping failed for project ${key.projectId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
  });
  c.executionCtx.waitUntil(bookkeeping);

  return c.json({ accepted: rows.length, dropped: parsed.dropped + outsideWindow });
}

export const serverRoutes = new Hono<{ Bindings: Env }>();

serverRoutes.post('/v1/track', (c) => handle(c, TRACK));
serverRoutes.post('/v1/import', (c) => handle(c, IMPORT));
