/**
 * WeldSign entity events. Payloads carry ids, title and status only: field
 * values, signature images and access codes never ride the bus (EVT-005).
 * `sign_events` is the legal evidence trail, not these events.
 */
export const SIGN_ENTITY_EVENTS = {
  /**
   * `updated`: anything about a draft changed (settings, documents,
   * recipients, fields). Sending, signing and completion get their own
   * actions when they ship (docs/plans/weldsign.md, phase 2).
   */
  sign_envelope: ['created', 'updated', 'deleted'],
} as const;
