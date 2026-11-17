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

/** The columns that say where an event happened: the page and browser on the web, the screen and device in an app. */
type Place = Pick<
  PanelEventRow,
  'url' | 'host' | 'path' | 'title' | 'referrer' | 'referrer_host' | 'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content' | 'utm_term' | 'device_type' | 'browser' | 'os'
>;

/** A web event's place: its cleaned URL (none for a non-http page) and the request's user agent. */
function webPlace(event: WireEvent, userAgent: ParsedUserAgent): Place | null {
  const page = parsePageUrl(event.url);
  if (!page) return null;
  const referrer = parseReferrer(event.referrer);
  return {
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
    device_type: userAgent.deviceType,
    browser: userAgent.browser,
    os: userAgent.os,
  };
}

const MAX_SCREEN = 200;
/** A bundle id or package name (`com.acme.shop`). */
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** ASCII whitespace only, so the Rust collector cuts screen names the same way. */
const SCREEN_EDGE_SPACE = /^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g;
const SCREEN_SPACE_RUN = /[ \t\n\r\v\f]+/g;
const MOBILE_OS: Record<string, string> = { ios: 'iOS', ipados: 'iOS', android: 'Android', windows: 'Windows', macos: 'macOS' };

/**
 * A mobile event's place (`lib: 'mobile'`, the React Native SDK), from the `$`
 * properties the SDK sets: `app://<$app_id>/<$screen_name>` with whitespace
 * runs as `-`, the screen name as the title, `$os` and `$device_type` as the
 * device. The wire `url` is not read: an `app:` URL is no page.
 */
function mobilePlace(event: WireEvent): Place {
  const prop = (key: string): string | null => {
    const value = event.props?.[key];
    return typeof value === 'string' ? value : null;
  };
  const rawAppId = prop('$app_id');
  const appId = rawAppId !== null && APP_ID.test(rawAppId) ? rawAppId : null;
  const screen = prop('$screen_name')?.replace(SCREEN_EDGE_SPACE, '') || null;
  const path = screen ? `/${screen.replace(SCREEN_SPACE_RUN, '-').slice(0, MAX_SCREEN)}` : '/';
  const deviceType = prop('$device_type');
  return {
    url: appId ? `app://${appId}${path}` : '',
    host: appId ?? '',
    path,
    title: screen ? screen.slice(0, MAX_SCREEN) : orNull(event.title),
    referrer: null,
    referrer_host: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    device_type: deviceType === 'mobile' || deviceType === 'tablet' ? deviceType : null,
    browser: null,
    os: MOBILE_OS[prop('$os')?.toLowerCase() ?? ''] ?? null,
  };
}

/**
 * One row per event. Events on a non-http page (web), on an excluded path, or
 * that need a cookieless id when none was derived are left out.
 */
export function buildEventRows(source: RowSource): PanelEventRow[] {
  const { record, batch, receivedAt, userAgent, geo, cookielessId } = source;
  const isExcluded = excludedPathMatcher(record.settings.excludedUrls);
  const receivedIso = new Date(receivedAt).toISOString();
  const rows: PanelEventRow[] = [];
  const mobile = batch.lib === 'mobile';

  for (const event of batch.events) {
    const place = mobile ? mobilePlace(event) : webPlace(event, userAgent);
    if (!place || isExcluded(place.path)) continue;

    const consented = consentedAnonId(batch, event);
    const anonId = consented ?? cookielessId;
    if (!anonId) continue;

    // A user id is personal data like the anonymous id: only with consent (and so only next to a consented id).
    const userId = consented ? orNull(event.user_id) : null;
    rows.push({
      event_id: event.event_id,
      workspace_id: record.workspaceId,
      project_id: record.projectId,
      name: event.name,
      ts: new Date(correctTimestamp(event.ts, batch.sent_at, receivedAt)).toISOString(),
      received_at: receivedIso,
      distinct_id: userId ?? anonId,
      anon_id: anonId,
      user_id: userId,
      session_id: consented ? orNull(event.session_id) : null,
      cookieless: !consented,
      ...place,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      viewport_w: event.viewport_w ?? null,
      el_tag: orNull(event.el?.tag),
      el_selector: orNull(event.el?.selector),
      el_text: orNull(event.el?.text),
      x: event.x ?? null,
      y: event.y ?? null,
      rel_x: event.rel_x ?? null,
      rel_y: event.rel_y ?? null,
      scroll_depth: event.scroll_depth ?? null,
      error_message: orNull(event.error_message),
      // events_v1 has no column for click vs submit, so autocapture keeps it in
      // the reserved `$action` property (client keys can't start with `$`).
      properties: JSON.stringify(event.el ? { ...event.props, $action: event.el.action } : (event.props ?? {})),
      lib: batch.lib,
      lib_version: batch.lib_version,
    });
  }
  return rows;
}
