/**
 * One row of the Basin table `panel.events_v1` (ADR PANEL-002), as the
 * collector writes it to the events stream. The stream's schema file is
 * `./events-v1-schema.json`; a test keeps the two in step.
 *
 * A pipeline cannot be changed after creation and drops rows that do not
 * match its schema without an error, so a column change means a new
 * `events_v2` stream, sink, pipeline and table.
 *
 * Phase 1 fills the web-analytics columns. `user_id` (phase 3), `rel_x` /
 * `rel_y` (phase 5) and `error_message` (phase 4) stay null until their phase,
 * but exist from the start so the table does not need a `_v2` for them.
 */

export interface PanelEventRow {
  event_id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  /** Event time, corrected for client clock skew, ISO 8601. */
  ts: string;
  received_at: string;
  /** `user_id` when known, else `anon_id`. */
  distinct_id: string;
  /** SDK id with consent; `ck_` + daily-rotating hash without. */
  anon_id: string;
  user_id: string | null;
  /** Null for cookieless visitors: their sessions are derived at query time. */
  session_id: string | null;
  cookieless: boolean;
  url: string;
  host: string;
  path: string;
  title: string | null;
  referrer: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device_type: 'desktop' | 'mobile' | 'tablet' | null;
  browser: string | null;
  os: string | null;
  viewport_w: number | null;
  el_tag: string | null;
  el_selector: string | null;
  el_text: string | null;
  x: number | null;
  y: number | null;
  rel_x: number | null;
  rel_y: number | null;
  scroll_depth: number | null;
  error_message: string | null;
  /**
   * Custom properties, JSON object as a string (`{}` when none). Keys starting
   * with `$` are the collector's own: `$action` (`click` / `submit`) on
   * `$autocapture` events, which have no column for it.
   */
  properties: string;
  lib: string;
  lib_version: string;
}
