/**
 * `/api/mail-messages` — backed by `mail_messages`.
 *
 * Includes `POST /:id/reply` (Cloudflare `[[send_email]]` via the
 * shared `sendAndPersist` helper) and the bulk action endpoint.
 */

import { z } from 'zod';

export const updateMailMessageSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isFlagged: z.boolean().optional(),
  isImportant: z.boolean().optional(),
  isSpam: z.boolean().optional(),
  isTrash: z.boolean().optional(),
  threadId: z.string().nullish(),
  labels: z.array(z.string()).optional(),
});

export const bulkMailMessageActionSchema = z.object({
  messageIds: z.array(z.string()).min(1).max(100),
  action: z.enum([
    'markRead', 'markUnread', 'star', 'unstar', 'flag', 'unflag',
    'trash', 'restore', 'delete',
  ]),
});

export const mailMessageLabelsSchema = z.object({
  labels: z.array(z.string()).min(1),
});

export const replyMailMessageSchema = z.object({
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyAll: z.boolean().default(false),
});

export const forwardMailMessageSchema = z.object({
  to: z.array(z.string().email()).min(1),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(500),
        contentType: z.string().max(255).optional(),
        size: z.number().int().nonnegative(),
        fileKey: z.string().min(1),
      }),
    )
    .optional(),
});

export const listMailMessagesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  accountId: z.string().optional(),
  search: z.string().optional(),
  isRead: z.coerce.boolean().optional(),
  isStarred: z.coerce.boolean().optional(),
  isFlagged: z.coerce.boolean().optional(),
  hasAttachments: z.coerce.boolean().optional(),
  threadId: z.string().optional(),
  label: z.string().optional(),
});

export type UpdateMailMessageInput = z.infer<typeof updateMailMessageSchema>;
export type BulkMailMessageActionInput = z.infer<typeof bulkMailMessageActionSchema>;
export type MailMessageLabelsInput = z.infer<typeof mailMessageLabelsSchema>;
export type ReplyMailMessageInput = z.infer<typeof replyMailMessageSchema>;
export type ForwardMailMessageInput = z.infer<typeof forwardMailMessageSchema>;
export type ListMailMessagesQuery = z.infer<typeof listMailMessagesQuery>;
