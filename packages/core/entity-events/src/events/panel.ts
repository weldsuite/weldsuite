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
} as const;
