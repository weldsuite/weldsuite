/**
 * `/api/mail-snooze` — per-message snooze state. URLs are scoped by
 * `accountId` since a `messageId` is only unique within an account.
 */

import { z } from 'zod';

export const snoozeMessageSchema = z.object({ until: z.string().datetime() });
export const resnoozeMessageSchema = z.object({ until: z.string().datetime() });
export const listSnoozedMessagesQuery = z.object({ accountId: z.string().optional() });

export type SnoozeMessageInput = z.infer<typeof snoozeMessageSchema>;
export type ResnoozeMessageInput = z.infer<typeof resnoozeMessageSchema>;
export type ListSnoozedMessagesQuery = z.infer<typeof listSnoozedMessagesQuery>;
