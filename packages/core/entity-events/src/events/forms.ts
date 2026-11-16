/**
 * WeldForms entity events (weldsuite-documentation/plans/weldforms.md, ADR FORMS-004).
 *
 * `form_response` payloads carry the answers keyed by field `ref` with
 * display values, so WeldConnect triggers and webhooks can use them. File
 * contents, signatures and every field the author marked sensitive are left
 * out: a sensitive answer never leaves forms-api except through the member
 * API and exports.
 */
export const FORMS_ENTITY_EVENTS = {
  /**
   * `updated`: the draft, settings, theme or access changed. `published`: a
   * new version went live (first publish or "Publish changes"). `closed`: it
   * stopped taking responses (by hand, its close date or its limit is read on
   * the public side and does not publish this).
   */
  form: ['created', 'updated', 'deleted', 'published', 'closed'],
  /**
   * `submitted`: a respondent finished ("form submitted" in WeldConnect).
   * `updated`: a verified respondent edited their response. `deleted`: a
   * member deleted it, or an erase request removed it.
   */
  form_response: ['submitted', 'updated', 'deleted'],
  form_folder: ['created', 'updated', 'deleted'],
  form_theme: ['created', 'updated', 'deleted'],
  /** An integration's settings, or its enabled switch. Runs are `form_response_actions`, not events. */
  form_integration: ['created', 'updated', 'deleted'],
  /** `sent` covers reminders and resends too (the payload says which). */
  form_invitation: ['sent', 'completed', 'revoked'],
} as const;
