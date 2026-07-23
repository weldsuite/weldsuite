/**
 * `/api/mail-accounts` — backed by `mail_accounts`.
 *
 * Mirrors `apps/workers/app-api/src/routes/mail-accounts/index.ts`. The router
 * also owns `POST /:id/send` (compose) and `PATCH /:id/assign-users` —
 * see the matching `sendEmailSchema` and `assignUsersSchema` below.
 */

import { z } from 'zod';

export const mailAccountProvider = z.enum([
  'gmail', 'outlook', 'office365', 'exchange', 'imap', 'yahoo',
  'mailcow', 'resend', 'smtp', 'cloudflare', 'custom',
]);

export const createMailAccountSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  displayName: z.string().max(255).optional(),
  provider: mailAccountProvider.default('imap'),
  authType: z.enum(['oauth2', 'password', 'api_key']).default('password'),
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().optional(),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.number().int().optional(),
  smtpSecure: z.boolean().default(true),
  syncEnabled: z.boolean().default(true),
  syncFrequency: z.number().int().default(5),
  signature: z.string().optional(),
  dailySendLimit: z.number().int().default(500),
  isDefault: z.boolean().default(false),
  isShared: z.boolean().default(true),
  assignedUserIds: z.array(z.string()).optional(),
  aiSettings: z
    .object({
      customInstructions: z.string().max(2000).optional(),
      defaultTone: z.enum(['professional', 'friendly', 'casual']).optional(),
      defaultLength: z.enum(['short', 'medium', 'long']).optional(),
      modelPreference: z.string().max(100).optional(),
    })
    .optional(),
});

export const updateMailAccountSchema = createMailAccountSchema.partial();

export const listMailAccountsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  provider: z.string().optional(),
});

export const assignMailAccountUsersSchema = z.object({
  isShared: z.boolean(),
  assignedUserIds: z.array(z.string()).default([]),
});

export const mailSendAttachmentSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().nonnegative(),
  /** R2 object key returned by `POST /api/storage/generate-upload-url`. */
  fileKey: z.string().min(1),
});

export const sendMailMessageSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().optional().default('(No subject)'),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyTo: z.string().email().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  attachments: z.array(mailSendAttachmentSchema).optional(),
  /**
   * Client-generated key that makes a send idempotent: if the same key is
   * replayed (e.g. an offline send queued by the mobile app, or a retry after a
   * dropped response), the server returns the already-sent message instead of
   * sending again. One key per composed message.
   */
  idempotencyKey: z.string().min(1).max(64).optional(),
});

export type CreateMailAccountInput = z.infer<typeof createMailAccountSchema>;
export type UpdateMailAccountInput = z.infer<typeof updateMailAccountSchema>;
export type ListMailAccountsQuery = z.infer<typeof listMailAccountsQuery>;
export type AssignMailAccountUsersInput = z.infer<typeof assignMailAccountUsersSchema>;
export type MailSendAttachmentInput = z.infer<typeof mailSendAttachmentSchema>;
export type SendMailMessageInput = z.infer<typeof sendMailMessageSchema>;
