/**
 * `/api/mail-threads` — thread-level mutations spanning every message
 * sharing a `threadId`. Read-side aggregation lives on
 * `/api/mail-labels/threads`.
 */

import { z } from 'zod';

export const markThreadReadSchema = z.object({ isRead: z.boolean() });

export type MarkThreadReadInput = z.infer<typeof markThreadReadSchema>;

/**
 * "Mark all as read" for a folder: one mailbox's, or the unified folder over
 * every mailbox the caller can read when `accountId` is left out.
 */
export const markFolderReadSchema = z.object({
  labelSlug: z.string().min(1).max(100),
  accountId: z.string().min(1).optional(),
});

export type MarkFolderReadInput = z.infer<typeof markFolderReadSchema>;
