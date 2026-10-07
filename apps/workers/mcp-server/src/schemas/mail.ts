/**
 * WeldMail schemas for the MCP surface.
 *
 * Unlike the rest of `src/schemas/`, these are **not** copied from
 * `@weldsuite/core-api-client`. That package's `mail-drafts` / `mail-labels`
 * schemas are legacy `.passthrough()` shapes whose field names drifted from the
 * table (`bodyText` vs `mail_drafts.body`, `toEmails` vs `to`,
 * `replyToMessageId` vs `in_reply_to`). Handing those names to a model would
 * produce drafts whose body and recipients silently land nowhere.
 *
 * These mirror the request bodies of the shared v1 routes
 * (`src/api/routes/v1/mail-drafts`, `.../mail-labels`, kept identical to
 * external-api's), which match the columns. Keep them in sync with those files.
 */

import { z } from 'zod';

/** A recipient list of bare addresses (the routes reject `Name <addr>`). */
const emailList = z.array(z.string().email()).max(100);

export const createMailDraftSchema = z.object({
  accountId: z
    .string()
    .min(1)
    .describe('Mail account to compose from — from search_mail_accounts'),
  subject: z.string().max(998).optional().describe('Subject line'),
  to: emailList.optional().describe('Recipient email addresses'),
  cc: emailList.optional().describe('CC email addresses'),
  bcc: emailList.optional().describe('BCC email addresses'),
  replyTo: z
    .array(z.string().email())
    .max(5)
    .optional()
    .describe('Reply-To addresses, when it differs from the sender'),
  body: z.string().optional().describe('Plain-text body'),
  htmlBody: z.string().optional().describe('HTML body; omit for a plain-text draft'),
  importance: z.enum(['low', 'normal', 'high']).optional().describe('Priority flag (default normal)'),
  labels: z.array(z.string()).optional().describe('Label names to attach to the draft'),
  attachmentIds: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Upload ids of files to attach (uploads happen outside MCP)'),
  inReplyTo: z
    .string()
    .max(500)
    .optional()
    .describe("RFC 5322 Message-ID being replied to — the email's `messageId`, not its record id"),
  originalMessageId: z
    .string()
    .optional()
    .describe('Record id of the email being replied to or forwarded'),
  isReply: z.boolean().optional().describe('Mark the draft as a reply'),
  isForward: z.boolean().optional().describe('Mark the draft as a forward'),
});

export const createMailLabelSchema = z.object({
  accountId: z
    .string()
    .min(1)
    .describe('Mail account the label belongs to — from search_mail_accounts'),
  name: z.string().min(1).max(100).describe('Label name, unique per account (case-insensitive)'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe('Hex colour such as #FF5733'),
  aiEnabled: z
    .boolean()
    .optional()
    .describe('Let WeldMail auto-apply this label to incoming mail'),
  aiKeywords: z
    .array(z.string())
    .optional()
    .describe('Keywords that suggest the label when auto-labelling'),
  aiDescription: z
    .string()
    .optional()
    .describe('Plain-language description of what belongs under this label'),
  aiConfidence: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Minimum confidence (0-100) before auto-labelling applies it; default 70'),
});

/** Every draft field is optional on an update; `id` names the draft. */
export const updateMailDraftSchema = createMailDraftSchema
  .partial()
  .extend({ id: z.string().describe('The draft — the id from search_mail_drafts or create_mail_draft') });

/** A label update: rename, recolour, reorder, or change auto-labelling. */
export const updateMailLabelSchema = createMailLabelSchema
  .omit({ accountId: true })
  .partial()
  .extend({
    id: z.string().describe('The label — its name, or the id from an earlier search'),
    position: z.number().int().optional().describe('Sort position among the labels of the account'),
  });

export type CreateMailDraftInput = z.infer<typeof createMailDraftSchema>;
export type CreateMailLabelInput = z.infer<typeof createMailLabelSchema>;
