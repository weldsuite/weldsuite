/**
 * `/api/mail-sync` — manages `mail_accounts.syncStatus`. The actual
 * IMAP/Graph fetch runs out-of-band (legacy: Next.js server action;
 * planned: a Trigger.dev job per provider). Cloudflare-routed accounts
 * are push-driven and treat sync as a no-op.
 */

import { z } from 'zod';

export const syncMessagesQuery = z.object({ label: z.string().optional() });
export const forceResyncSchema = z.object({ label: z.string().optional() });

export const updateMailSyncStatusSchema = z.object({
  status: z.enum(['idle', 'syncing', 'error']),
  errorMessage: z.string().optional(),
});

export type SyncMessagesQuery = z.infer<typeof syncMessagesQuery>;
export type ForceResyncInput = z.infer<typeof forceResyncSchema>;
export type UpdateMailSyncStatusInput = z.infer<typeof updateMailSyncStatusSchema>;
