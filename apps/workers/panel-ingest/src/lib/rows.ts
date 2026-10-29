/**
 * Turns the events of one accepted batch into `events_v1` rows: corrects the
 * clock, cleans the URLs, adds geo and device from the request, and settles
 * which visitor id the event carries (ADR PANEL-006).
 */

import type { PanelEventRow } from '@weldsuite/panel-domain/event-row';
import type { PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import type { EventBatch, WireEvent } from '@weldsuite/panel-domain/wire';
import { COOKIELESS_PREFIX } from './visitor';
import { parsePageUrl, parseReferrer, excludedPathMatcher } from './url';
import type { ParsedUserAgent } from './user-agent';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Events older than this are not believed (a clock years off), newer than a minute ahead neither. */
const MAX_AGE_MS = 7 * DAY_MS;
const MAX_AHEAD_MS = 60 * 1000;

/**
 * The event time on the server's clock. A client clock that is off shifts
 * `ts` and `sent_at` by the same amount, so `ts + (receivedAt - sent_at)` is
 * right wherever that clock was; the result is clamped to a sane window.
 */
export function correctTimestamp(ts: string, sentAt: string, receivedAt: number): number {
  const corrected = Date.parse(ts) + (receivedAt - Date.parse(sentAt));
  return Math.min(Math.max(corrected, receivedAt - MAX_AGE_MS), receivedAt + MAX_AHEAD_MS);
}

/**
 * The browser's own anonymous id, usable only with consent. The `ck_` prefix is
 * ours: a browser cannot present an id that looks like a cookieless hash.
 */
export function consentedAnonId(batch: Pick<EventBatch, 'consent'>, event: Pick<WireEvent, 'anon_id'>): string | null {
  if (!batch.consent || !event.anon_id || event.anon_id.startsWith(COOKIELESS_PREFIX)) return null;
  return event.anon_id;
}

export interface RowSource {
  record: PanelProjectRecord;
  batch: EventBatch;
  receivedAt: number;
  userAgent: ParsedUserAgent;
  geo: { country: string | null; region: string | null; city: string | null };
  /** The cookieless visitor id of this request, when some event needs it. */
  cookielessId: string | null;
}

const orNull = (value: string | undefined | null): string | null => (value ? value : null);

/**
 * One row per event. Events on a non-http page, on an excluded path, or that
 * need a cookieless id when none was derived are left out.
 */
export function buildEventRows(source: RowSource): PanelEventRow[] {
  const { record, batch, receivedAt, userAgent, geo, cookielessId } = source;
  const isExcluded = excludedPathMatcher(record.settings.excludedUrls);
  const receivedIso = new Date(receivedAt).toISOString();
  const rows: PanelEventRow[] = [];

  for (const event of batch.events) {
    const page = parsePageUrl(event.url);
    if (!page || isExcluded(page.path)) continue;

    const consented = consentedAnonId(batch, event);
    const anonId = consented ?? cookielessId;
    if (!anonId) continue;

    const referrer = parseReferrer(event.referrer);
    rows.push({
      event_id: event.event_id,
      workspace_id: record.workspaceId,
      project_id: record.projectId,
      name: event.name,
      ts: new Date(correctTimestamp(event.ts, batch.sent_at, receivedAt)).toISOString(),
      received_at: receivedIso,
      distinct_id: anonId,
      anon_id: anonId,
      user_id: null,
      session_id: consented ? orNull(event.session_id) : null,
      cookieless: !consented,
      url: page.url,
      host: page.host,
      path: page.path,
      title: orNull(event.title),
      referrer: referrer.referrer,
      referrer_host: referrer.host,
      utm_source: page.utm.source,
      utm_medium: page.utm.medium,
      utm_campaign: page.utm.campaign,
      utm_content: page.utm.content,
      utm_term: page.utm.term,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      device_type: userAgent.deviceType,
      browser: userAgent.browser,
      os: userAgent.os,
      viewport_w: event.viewport_w ?? null,
      el_tag: orNull(event.el?.tag),
      el_selector: orNull(event.el?.selector),
      el_text: orNull(event.el?.text),
      x: event.x ?? null,
      y: event.y ?? null,
      rel_x: null,
      rel_y: null,
      scroll_depth: event.scroll_depth ?? null,
      error_message: null,
      // events_v1 has no column for click vs submit, so autocapture keeps it in
      // the reserved `$action` property (client keys can't start with `$`).
      properties: JSON.stringify(event.el ? { ...event.props, $action: event.el.action } : (event.props ?? {})),
      lib: batch.lib,
      lib_version: batch.lib_version,
    });
  }
  return rows;
}
