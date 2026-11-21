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

export const forwardMailMessageSchema = z.object({
  to: z.array(z.string().email()).min(1),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  /** Ids of the original's attachments to leave out; the rest are forwarded. */
  excludeAttachmentIds: z.array(z.string()).max(100).optional(),
  /** Attach the original as an .eml file instead of quoting it. */
  asAttachment: z.boolean().optional(),
  /** Sender's IANA time zone and locale, for the quoted Date line. */
  timeZone: z.string().max(64).optional(),
  locale: z.string().max(35).optional(),
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
  /** Exact address match — the CRM Emails tab (mailbox-store design §5). */
  counterparty: z.string().min(1).optional(),
});

export type UpdateMailMessageInput = z.infer<typeof updateMailMessageSchema>;
export type BulkMailMessageActionInput = z.infer<typeof bulkMailMessageActionSchema>;
export type MailMessageLabelsInput = z.infer<typeof mailMessageLabelsSchema>;
export type ReplyMailMessageInput = z.infer<typeof replyMailMessageSchema>;
export type ForwardMailMessageInput = z.infer<typeof forwardMailMessageSchema>;
export type ListMailMessagesQuery = z.infer<typeof listMailMessagesQuery>;

/**
 * What the server found wrong with a received message (EU and self-hosted
 * editions; absent on Global). A message with any `infected` or `malicious`
 * entry was moved to Spam by the server.
 */
export const mailLinkReasonCodeSchema = z.enum(['threat_feed', 'ip_host', 'userinfo', 'homograph']);
export const mailLinkThreatKindSchema = z.enum(['malware', 'phishing']);

export const mailThreatSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attachment'),
    verdict: z.literal('infected'),
    fileName: z.string(),
    attachmentId: z.string().optional(),
    signature: z.string(),
  }),
  z.object({
    kind: z.literal('link'),
    verdict: z.enum(['malicious', 'suspicious']),
    url: z.string(),
    reason: mailLinkReasonCodeSchema,
    source: z.string().optional(),
    threat: mailLinkThreatKindSchema.optional(),
  }),
]);

export const mailThreatsSchema = z.array(mailThreatSchema).nullish();

export type MailThreat = z.infer<typeof mailThreatSchema>;

/** `POST /api/mail-messages/:id/link-check`: click-time check of one link. */
export const mailLinkCheckSchema = z.object({
  url: z.string().min(1).max(4096),
  /** The anchor's visible text, used to spot a link that shows one address and goes to another. */
  text: z.string().max(500).optional(),
});

export const mailLinkCheckResultSchema = z.object({
  url: z.string(),
  verdict: z.enum(['safe', 'suspicious', 'malicious']),
  reasons: z.array(
    z.object({
      code: mailLinkReasonCodeSchema,
      source: z.string().optional(),
      threat: mailLinkThreatKindSchema.optional(),
    }),
  ),
});

export type MailLinkCheckInput = z.infer<typeof mailLinkCheckSchema>;
export type MailLinkCheckResult = z.infer<typeof mailLinkCheckResultSchema>;
export type MailLinkReasonCode = z.infer<typeof mailLinkReasonCodeSchema>;
