/**
 * WeldPanel entity events. Payloads carry id, name, kind and status only: the
 * project token and settings stay off the bus. Tracked visitor events never go
 * on it at all, there are too many and they carry customer user data (EVT-005).
 */
export const PANEL_ENTITY_EVENTS = {
  /**
   * A tracked website or app. `updated` covers a rename, allowed domains,
   * collector and privacy settings, pausing or resuming, and a token rotation.
   */
  panel_project: ['created', 'updated', 'deleted'],
  /** A saved query. Payload: id, name, kind, visibility and project id; the spec stays off the bus. */
  panel_report: ['created', 'updated', 'deleted'],
  /** A dashboard; adding, moving or removing a tile is an `updated`. */
  panel_dashboard: ['created', 'updated', 'deleted'],
  /** A saved filter on tracked users. Payload: id, name and project id; the filter stays off the bus. */
  panel_cohort: ['created', 'updated', 'deleted'],
  /** What the team wrote about an event or property name (lexicon). Payload: id, project id, kind, name, hidden and verified. */
  panel_event_definition: ['created', 'updated'],
  /** A saved heatmap page group. Payload: id, project id, name and URL pattern. */
  panel_heatmap_page: ['created', 'updated', 'deleted'],
  /**
   * A secret key for server-side ingest: `created`, and `deleted` when it is revoked.
   * Payload: id, project id, name and the key's visible prefix, never the key.
   */
  panel_key: ['created', 'deleted'],
} as const;
