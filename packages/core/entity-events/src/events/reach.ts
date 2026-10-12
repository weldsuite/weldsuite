/**
 * WeldReach (cold email outreach) entity events.
 *
 * Payloads never carry mailbox credentials: publishers strip the encrypted
 * columns (SENSITIVE_COLUMNS in `@weldsuite/db/lib/sensitive-columns`).
 * `reach_reply:classified` with label `interested` is what WeldConnect
 * workflows hook into to create opportunities or notify sales.
 */
export const REACH_ENTITY_EVENTS = {
  reach_campaign: ['created', 'updated', 'deleted', 'launched', 'paused', 'completed'],
  reach_mailbox: ['created', 'updated', 'deleted', 'suspended'],
  reach_domain: ['connected', 'updated', 'disconnected'],
  reach_prospect: ['created', 'updated', 'deleted'],
  reach_reply: ['received', 'classified'],
} as const;
