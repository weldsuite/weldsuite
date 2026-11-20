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
  /** A custom event (several events under one name). Payload: id, project id and name; the definition stays off the bus. */
  panel_custom_event: ['created', 'updated', 'deleted'],
  /** A computed property. Payload: id, project id and name. */
  panel_computed_property: ['created', 'updated', 'deleted'],
  /** A path cleaning rule. Payload: id, project id, position, pattern and replacement. */
  panel_path_rule: ['created', 'updated', 'deleted'],
  /** A group type for group analytics. Payload: id, project id, group type and names. */
  panel_group_type: ['created', 'updated', 'deleted'],
  /** A chart annotation. Payload: id, project id, report id, date and label. */
  panel_annotation: ['created', 'updated', 'deleted'],
  /** A comment on a report or dashboard. Payload: id, project id, target and author; the body stays off the bus. */
  panel_comment: ['created', 'updated', 'deleted'],
  /** A metric tree. Payload: id, project id, name and visibility; the nodes stay off the bus. */
  panel_metric_tree: ['created', 'updated', 'deleted'],
  /** A public link to a report or dashboard: `created`, and `deleted` when revoked. Payload: id, project id, target and the token's prefix, never the token. */
  panel_share_link: ['created', 'deleted'],
  /** An alert on a metric; `fired` and `resolved` when its state changes. Payload: id, project id, name, state and value; channels stay off the bus. */
  panel_alert: ['created', 'updated', 'deleted', 'fired', 'resolved'],
  /** A scheduled report delivery. Payload: id, project id, name, target and schedule; channels stay off the bus. */
  panel_subscription: ['created', 'updated', 'deleted'],
  /** A raw export to the customer's bucket. Payload: id, project id, name, provider, bucket and status; credentials stay off the bus. */
  panel_export: ['created', 'updated', 'deleted'],
  /** A custom collector host name. Payload: id, project id, host name and status. */
  panel_custom_domain: ['created', 'updated', 'deleted'],
} as const;
