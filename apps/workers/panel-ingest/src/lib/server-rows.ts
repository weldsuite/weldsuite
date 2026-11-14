/**
 * `events_v1` rows for events sent with a secret key (`/v1/track`,
 * `/v1/import`). There is no browser: no session, no viewport, and no geo or
 * user agent (the request is the customer's server, not their visitor), so
 * those columns stay null. The caller names the visitor (`distinct_id`).
 */

import type { PanelEventRow } from '@weldsuite/panel-domain/event-row';
import type { PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import type { ServerBatch, ServerEvent } from '@weldsuite/panel-domain/wire';
import { parsePageUrl } from './url';

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRACK_MAX_AGE_MS = 7 * DAY_MS;
export const IMPORT_MAX_AGE_MS = 5 * 365 * DAY_MS;
/** A clock a little ahead is believed (and moved back to now); further ahead is not. */
const MAX_AHEAD_MS = 60 * 1000;

/**
 * The event time, or null when it is outside what the endpoint takes: older
 * than `maxAgeMs`, or more than a minute in the future. A time up to a minute
 * ahead is clamped to the receive time ("never in the future").
 */
export function serverEventTime(ts: string, receivedAt: number, maxAgeMs: number): number | null {
  const at = Date.parse(ts);
  if (Number.isNaN(at) || at < receivedAt - maxAgeMs || at > receivedAt + MAX_AHEAD_MS) return null;
  return Math.min(at, receivedAt);
}

export interface ServerRowSource {
  record: Pick<PanelProjectRecord, 'workspaceId' | 'projectId'>;
  batch: ServerBatch;
  receivedAt: number;
  maxAgeMs: number;
}

const orNull = (value: string | undefined | null): string | null => (value ? value : null);

/** One row per event inside the time window; `dropped` counts the rest. */
export function buildServerEventRows(source: ServerRowSource): { rows: PanelEventRow[]; dropped: number } {
  const { record, batch, receivedAt, maxAgeMs } = source;
  const receivedIso = new Date(receivedAt).toISOString();
  const rows: PanelEventRow[] = [];

  for (const event of batch.events) {
    const at = serverEventTime(event.ts, receivedAt, maxAgeMs);
    if (at === null) continue;
    rows.push(serverRow(record, batch, event, new Date(at).toISOString(), receivedIso));
  }
  return { rows, dropped: batch.events.length - rows.length };
}

function serverRow(
  record: Pick<PanelProjectRecord, 'workspaceId' | 'projectId'>,
  batch: ServerBatch,
  event: ServerEvent,
  ts: string,
  receivedIso: string,
): PanelEventRow {
  const page = event.url ? parsePageUrl(event.url) : null;
  return {
    event_id: event.event_id,
    workspace_id: record.workspaceId,
    project_id: record.projectId,
    name: event.name,
    ts,
    received_at: receivedIso,
    distinct_id: event.distinct_id,
    anon_id: event.anon_id || event.distinct_id,
    user_id: orNull(event.user_id),
    session_id: null,
    cookieless: false,
    url: page?.url ?? '',
    host: page?.host ?? '',
    path: page?.path ?? '',
    title: orNull(event.title),
    referrer: null,
    referrer_host: null,
    utm_source: page?.utm.source ?? null,
    utm_medium: page?.utm.medium ?? null,
    utm_campaign: page?.utm.campaign ?? null,
    utm_content: page?.utm.content ?? null,
    utm_term: page?.utm.term ?? null,
    country: null,
    region: null,
    city: null,
    device_type: null,
    browser: null,
    os: null,
    viewport_w: null,
    el_tag: null,
    el_selector: null,
    el_text: null,
    x: null,
    y: null,
    rel_x: null,
    rel_y: null,
    scroll_depth: null,
    error_message: null,
    properties: JSON.stringify(event.props ?? {}),
    lib: batch.lib,
    lib_version: batch.lib_version,
  };
}
