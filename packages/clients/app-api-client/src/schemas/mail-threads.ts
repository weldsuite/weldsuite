/**
 * `/api/mail-threads` — thread-level mutations spanning every message
 * sharing a `threadId`. Read-side aggregation lives on
 * `/api/mail-labels/threads`.
 */

import { z } from 'zod';

export const markThreadReadSchema = z.object({ isRead: z.boolean() });

export type MarkThreadReadInput = z.infer<typeof markThreadReadSchema>;
