/**
 * `/api/mail-subscriptions` — mailing lists an account receives, with
 * Gmail-style unsubscribe.
 */

import { z } from 'zod';

export const mailSubscriptionStatusSchema = z.enum(['active', 'unsubscribed']);

export const listMailSubscriptionsQuery = z.object({
  accountId: z.string().min(1),
  status: mailSubscriptionStatusSchema.optional(),
});

export const scanMailSubscriptionsSchema = z.object({
  accountId: z.string().min(1),
});

export type MailSubscriptionStatus = z.infer<typeof mailSubscriptionStatusSchema>;
export type ListMailSubscriptionsQuery = z.infer<typeof listMailSubscriptionsQuery>;
export type ScanMailSubscriptionsInput = z.infer<typeof scanMailSubscriptionsSchema>;
