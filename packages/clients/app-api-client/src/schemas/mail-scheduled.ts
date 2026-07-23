/**
 * `/api/mail-scheduled` — store-then-send via the
 * `SEND_SCHEDULED_EMAIL` Cloudflare Workflow.
 *
 * The compose payload mirrors the regular send schema (same Cloudflare
 * `[[send_email]]` binding when the workflow eventually fires) plus a
 * `scheduledFor` ISO timestamp.
 */

import { z } from 'zod';
import { mailSendAttachmentSchema } from './mail-accounts';

export const scheduleMailSchema = z.object({
  accountId: z.string().min(1),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyTo: z.string().email().optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  attachmentIds: z.array(z.string()).optional(),
  attachments: z.array(mailSendAttachmentSchema).optional(),
  scheduledFor: z.string().datetime(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
});

export const rescheduleMailSchema = z.object({
  scheduledFor: z.string().datetime(),
});

export const listMailScheduledQuery = z.object({
  accountId: z.string().optional(),
});

export type ScheduleMailInput = z.infer<typeof scheduleMailSchema>;
export type RescheduleMailInput = z.infer<typeof rescheduleMailSchema>;
export type ListMailScheduledQuery = z.infer<typeof listMailScheduledQuery>;
