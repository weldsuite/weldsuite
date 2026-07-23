/**
 * WeldData (lead database) entity events.
 *
 * `welddata_list`  — a saved-lead bucket.
 * `welddata_lead`  — a single saved lead snapshot. `members_added` fires when
 *                    leads are saved into a list; `converted` fires when a lead
 *                    is materialised into a CRM person/company.
 */
export const WELDDATA_ENTITY_EVENTS = {
  welddata_list: ['created', 'updated', 'deleted', 'members_added'],
  welddata_lead: ['created', 'deleted', 'converted'],
  /** Enrichment columns. `run` fires when a column run is queued. */
  welddata_column: ['created', 'updated', 'deleted', 'run'],
} as const;
