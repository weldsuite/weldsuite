import { z } from 'zod';
import { createMailDraftSchema, createMailLabelSchema } from '../../schemas/mail';
import type { ToolDefinition } from '../registry';

/**
 * WeldMail tools — reading mail, organising it with labels, and composing
 * drafts.
 *
 * There is deliberately no send tool. Composing ends at a draft in the user's
 * Drafts folder; the send button stays with the human. The same reasoning
 * keeps destructive operations out: no delete, no rename, no bulk relabelling.
 *
 * Every tool is scoped to the mailboxes the caller can actually reach — mail
 * accounts carry their own per-user assignment on top of the workspace
 * permission, and the routes behind these tools enforce it (see
 * `api/lib/mail-access.ts`).
 */
export const mailTools: ToolDefinition[] = [
  // ── Accounts ────────────────────────────────────────────────────────────────
  {
    name: 'search_mail_accounts',
    scope: 'accounts:read',
    description:
      'List the WeldMail accounts (mailboxes) the current user can access. Start here when a mail tool needs an accountId, or to answer "which mailboxes do I have?".',
    inputSchema: {
      search: z.string().optional().describe('Match against account name, email or display name'),
      status: z
        .string()
        .optional()
        .describe('Filter by status (active, inactive, error, suspended, quota_exceeded)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 50)'),
    },
    method: 'GET',
    path: '/v1/mail-accounts',
  },
  {
    name: 'get_mail_account',
    scope: 'accounts:read',
    description: 'Get details of one WeldMail account, including its sync status.',
    inputSchema: {
      id: z
        .string()
        .describe('The mail account — its name or email address, or the id from an earlier search'),
    },
    method: 'GET',
    path: '/v1/mail-accounts/:id',
    pathParams: { id: 'id' },
  },

  // ── Messages ────────────────────────────────────────────────────────────────
  {
    name: 'search_emails',
    scope: 'messages:read',
    description:
      'Search and list emails, newest first. Returns headers only (subject, sender, date, flags) — use get_email for the body. Omit accountId to search every mailbox the user can access. Trash and spam are excluded unless asked for. Pass threadId to read a whole conversation.',
    inputSchema: {
      accountId: z
        .string()
        .optional()
        .describe('Restrict to one mailbox — the id from search_mail_accounts'),
      search: z.string().optional().describe('Match against subject, preview and message body'),
      from: z.string().optional().describe("Match against the sender's name or email address"),
      label: z
        .string()
        .optional()
        .describe(
          'Filter by label. System labels (inbox, sent, archive, starred, important, trash, spam, snoozed) are case-insensitive; user labels match exactly',
        ),
      threadId: z
        .string()
        .optional()
        .describe('Return every message in one conversation, from an earlier result'),
      isRead: z.boolean().optional().describe('true for read mail only, false for unread only'),
      isStarred: z.boolean().optional().describe('Filter by starred'),
      hasAttachments: z.boolean().optional().describe('Filter by whether the mail has attachments'),
      includeTrash: z.boolean().optional().describe('Include trashed mail (excluded by default)'),
      includeSpam: z.boolean().optional().describe('Include spam (excluded by default)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 50)'),
    },
    method: 'GET',
    path: '/v1/mail-messages',
  },
  {
    name: 'get_email',
    scope: 'messages:read',
    description:
      'Read one email in full: recipients, labels, and the message body. Returns the plain-text body by default.',
    inputSchema: {
      id: z.string().describe('The email — the id from an earlier search_emails result'),
      includeHtml: z
        .boolean()
        .optional()
        .describe(
          'Also return the HTML body. Off by default: it is much larger and mostly markup. The HTML is returned anyway when the message has no plain-text part',
        ),
    },
    method: 'GET',
    path: '/v1/mail-messages/:id',
    pathParams: { id: 'id' },
  },

  // ── Labels ──────────────────────────────────────────────────────────────────
  {
    name: 'search_mail_labels',
    scope: 'accounts:read',
    description:
      'List the labels defined on the user\'s mailboxes. Check here before creating a label — names are unique per account, case-insensitively.',
    inputSchema: {
      accountId: z.string().optional().describe('Restrict to one mailbox'),
      search: z.string().optional().describe('Match against the label name'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 50)'),
    },
    method: 'GET',
    path: '/v1/mail-labels',
  },
  {
    name: 'get_mail_label',
    scope: 'accounts:read',
    description:
      'Get one mail label, including its colour, message count and auto-labelling settings.',
    inputSchema: {
      id: z.string().describe('The label — its name, or the id from an earlier search'),
    },
    method: 'GET',
    path: '/v1/mail-labels/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_mail_label',
    scope: 'accounts:write',
    description:
      'Create a label on a mail account. Optionally enable AI auto-labelling so incoming mail matching the keywords or description gets the label applied automatically.',
    inputSchema: createMailLabelSchema.shape,
    method: 'POST',
    path: '/v1/mail-labels',
  },

  // ── Drafts ──────────────────────────────────────────────────────────────────
  {
    name: 'search_mail_drafts',
    scope: 'messages:read',
    description:
      'List unsent email drafts, most recently edited first. Returns headers only — use get_mail_draft for the body.',
    inputSchema: {
      accountId: z.string().optional().describe('Restrict to one mailbox'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 50)'),
    },
    method: 'GET',
    path: '/v1/mail-drafts',
  },
  {
    name: 'get_mail_draft',
    scope: 'messages:read',
    description: 'Read one email draft in full, including its body and recipients.',
    inputSchema: {
      id: z.string().describe('The draft — the id from an earlier search_mail_drafts result'),
    },
    method: 'GET',
    path: '/v1/mail-drafts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_mail_draft',
    scope: 'messages:write',
    description:
      "Compose an email and save it to the account's Drafts folder. It is NOT sent — the user reviews and sends it from WeldMail. To draft a reply, pass the original email's messageId as inReplyTo and its record id as originalMessageId, and set isReply.",
    inputSchema: createMailDraftSchema.shape,
    method: 'POST',
    path: '/v1/mail-drafts',
  },
];
