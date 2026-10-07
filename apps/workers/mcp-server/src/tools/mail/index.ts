import { z } from 'zod';
import {
  createMailDraftSchema,
  createMailLabelSchema,
  updateMailDraftSchema,
  updateMailLabelSchema,
} from '../../schemas/mail';
import type { ToolDefinition } from '../registry';

/**
 * WeldMail tools — reading mail, organising it, and composing drafts.
 *
 * There is deliberately no send tool, and there must never be one: composing
 * ends at a draft in the mailbox's Drafts folder, and the send button stays
 * with a person in WeldMail. The send, reply, forward, draft-send and upload
 * routes exist only on the public API (external-api's `mail-sending`), which
 * this server does not mount; `mail.test.ts` fails if a tool reaches for them.
 *
 * Organising (read state, stars, labels, moving) changes WeldSuite's copy only;
 * nothing is written back to Gmail, Outlook or IMAP.
 *
 * Every tool is scoped to the mailboxes the caller can open in WeldMail: a
 * mailbox carries its own assignee list on top of the workspace permission,
 * and the routes behind these tools enforce it through
 * `@weldsuite/mail-domain/access`.
 */

const accountId = z.string().describe('The mailbox — the id from search_mail_accounts');
const cursor = z.string().optional().describe('Pagination cursor from a previous response');

export const mailTools: ToolDefinition[] = [
  // ── Accounts ────────────────────────────────────────────────────────────────
  {
    name: 'search_mail_accounts',
    scope: 'mail_accounts:read',
    description:
      'List the WeldMail accounts (mailboxes) the current user can access. Start here when a mail tool needs an accountId, or to answer "which mailboxes do I have?".',
    inputSchema: {
      search: z.string().optional().describe('Match against account name, email or display name'),
      status: z
        .string()
        .optional()
        .describe('Filter by status (active, inactive, error, suspended, quota_exceeded)'),
      cursor,
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 50)'),
    },
    method: 'GET',
    path: '/v1/mail-accounts',
  },
  {
    name: 'get_mail_account',
    scope: 'mail_accounts:read',
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
    scope: 'mail_messages:read',
    description:
      'Search and list emails, newest first. Returns headers only (subject, sender, date, flags) — use get_email for the body. Omit accountId to search every mailbox the user can access. Trash and spam are excluded unless asked for. To read whole conversations, prefer list_mail_threads.',
    inputSchema: {
      accountId: accountId.optional(),
      search: z.string().optional().describe('Match against subject, body and participants'),
      from: z.string().optional().describe("Match against the sender's name or email address"),
      label: z
        .string()
        .optional()
        .describe(
          'Filter by label. System labels (inbox, sent, archive, starred, important, trash, spam, snoozed) are case-insensitive; user labels match exactly',
        ),
      threadId: z.string().optional().describe('Return every message in one conversation'),
      isRead: z.boolean().optional().describe('true for read mail only, false for unread only'),
      isStarred: z.boolean().optional().describe('Filter by starred'),
      hasAttachments: z.boolean().optional().describe('Filter by whether the mail has attachments'),
      includeTrash: z.boolean().optional().describe('Include trashed mail (excluded by default)'),
      includeSpam: z.boolean().optional().describe('Include spam (excluded by default)'),
      cursor,
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 50)'),
    },
    method: 'GET',
    path: '/v1/mail-messages',
  },
  {
    name: 'get_email',
    scope: 'mail_messages:read',
    description:
      'Read one email in full: recipients, labels, attachments (names and sizes) and the message body. Returns the plain-text body by default.',
    inputSchema: {
      id: z.string().describe('The email — the id from an earlier search_emails result'),
      includeHtml: z
        .boolean()
        .default(false)
        .describe(
          'Also return the HTML body. Off by default: it is much larger and mostly markup. The HTML is returned anyway when the message has no plain-text part',
        ),
    },
    method: 'GET',
    path: '/v1/mail-messages/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'update_email',
    scope: 'mail_messages:write',
    description:
      'Mark an email read or unread, star or unstar it, flag it, or mark it important. Changes WeldSuite only; nothing is written back to Gmail, Outlook or IMAP.',
    inputSchema: {
      id: z.string().describe('The email — the id from an earlier search_emails result'),
      isRead: z.boolean().optional(),
      isStarred: z.boolean().optional(),
      isFlagged: z.boolean().optional(),
      isImportant: z.boolean().optional(),
    },
    method: 'PATCH',
    path: '/v1/mail-messages/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'label_email',
    scope: 'mail_messages:write',
    description:
      'Add labels to or remove labels from one email. To move mail to the inbox, archive, trash or spam, use move_email instead.',
    inputSchema: {
      id: z.string().describe('The email — the id from an earlier search_emails result'),
      add: z.array(z.string()).optional().describe('Label names to add'),
      remove: z.array(z.string()).optional().describe('Label names to remove'),
    },
    method: 'POST',
    path: '/v1/mail-messages/:id/labels',
    pathParams: { id: 'id' },
  },
  {
    name: 'move_email',
    scope: 'mail_messages:write',
    description:
      'Move one email to the inbox, the archive, the trash, or spam. Moving to trash is reversible by moving it back to the inbox.',
    inputSchema: {
      id: z.string().describe('The email — the id from an earlier search_emails result'),
      location: z.enum(['inbox', 'archive', 'trash', 'spam']),
    },
    method: 'POST',
    path: '/v1/mail-messages/:id/move',
    pathParams: { id: 'id' },
  },

  // ── Threads ─────────────────────────────────────────────────────────────────
  {
    name: 'list_mail_threads',
    scope: 'mail_messages:read',
    description:
      'List conversations the way the WeldMail inbox shows them, newest activity first: subject, participants, message and unread counts, labels. Each result has a threadId and accountId for get_mail_thread. Omit accountId to cover every mailbox the user can access.',
    inputSchema: {
      accountId: accountId.optional(),
      label: z
        .string()
        .optional()
        .describe('Folder or label: inbox (default), sent, starred, archive, trash, spam, all, or a label name'),
      search: z.string().optional().describe('Search the whole mailbox (not just the folder) by subject, body and participants'),
      from: z.string().optional().describe("Sender's name or address contains this text"),
      to: z.string().optional().describe("A To/Cc recipient's name or address contains this text"),
      subject: z.string().optional().describe('Subject contains this text'),
      hasAttachments: z.boolean().optional(),
      cursor,
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/mail-threads',
  },
  {
    name: 'get_mail_thread',
    scope: 'mail_messages:read',
    description: 'Read a whole conversation, every message oldest first, with bodies.',
    inputSchema: {
      threadId: z.string().describe('The threadId from list_mail_threads'),
      accountId: z.string().describe('The accountId that came with the thread'),
    },
    method: 'GET',
    path: '/v1/mail-threads/:threadId',
    pathParams: { threadId: 'threadId' },
  },

  // ── Labels ──────────────────────────────────────────────────────────────────
  {
    name: 'search_mail_labels',
    scope: 'mail_labels:read',
    description:
      "List the labels defined on the user's mailboxes. Check here before creating a label — names are unique per account, case-insensitively.",
    inputSchema: {
      accountId: accountId.optional(),
      search: z.string().optional().describe('Match against the label name'),
    },
    method: 'GET',
    path: '/v1/mail-labels',
  },
  {
    name: 'get_mail_label',
    scope: 'mail_labels:read',
    description: 'Get one mail label, including its colour, message count and auto-labelling settings.',
    inputSchema: {
      id: z.string().describe('The label — its name, or the id from an earlier search'),
    },
    method: 'GET',
    path: '/v1/mail-labels/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_mail_label',
    scope: 'mail_labels:write',
    description:
      'Create a label on a mail account. Optionally enable AI auto-labelling so incoming mail matching the keywords or description gets the label applied automatically.',
    inputSchema: createMailLabelSchema.shape,
    method: 'POST',
    path: '/v1/mail-labels',
  },
  {
    name: 'update_mail_label',
    scope: 'mail_labels:write',
    description:
      'Rename, recolour or reorder a mail label, or change its auto-labelling. A rename applies to every email that carries the label.',
    inputSchema: updateMailLabelSchema.shape,
    method: 'PATCH',
    path: '/v1/mail-labels/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_mail_label',
    scope: 'mail_labels:write',
    description:
      'Delete a mail label. The emails stay; they just no longer carry it. Confirm with the user before calling this.',
    inputSchema: {
      id: z.string().describe('The label — its name, or the id from an earlier search'),
    },
    method: 'DELETE',
    path: '/v1/mail-labels/:id',
    pathParams: { id: 'id' },
  },

  // ── Folders ─────────────────────────────────────────────────────────────────
  {
    name: 'search_mail_folders',
    scope: 'mail_folders:read',
    description: "List the folders of the user's mailboxes, system folders (inbox, sent, …) included.",
    inputSchema: {
      accountId: accountId.optional(),
    },
    method: 'GET',
    path: '/v1/mail-folders',
  },

  // ── Drafts ──────────────────────────────────────────────────────────────────
  {
    name: 'search_mail_drafts',
    scope: 'mail_drafts:read',
    description: 'List unsent email drafts, most recently edited first.',
    inputSchema: {
      accountId: accountId.optional(),
      cursor,
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 50)'),
    },
    method: 'GET',
    path: '/v1/mail-drafts',
  },
  {
    name: 'get_mail_draft',
    scope: 'mail_drafts:read',
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
    scope: 'mail_drafts:write',
    description:
      "Compose an email and save it to the account's Drafts folder. It is NOT sent — the user reviews and sends it from WeldMail. To draft a reply, pass the original email's messageId as inReplyTo and its record id as originalMessageId, and set isReply.",
    inputSchema: createMailDraftSchema.shape,
    method: 'POST',
    path: '/v1/mail-drafts',
  },
  {
    name: 'update_mail_draft',
    scope: 'mail_drafts:write',
    description: 'Change a saved draft: recipients, subject, body or anything else. It is still not sent.',
    inputSchema: updateMailDraftSchema.shape,
    method: 'PATCH',
    path: '/v1/mail-drafts/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_mail_draft',
    scope: 'mail_drafts:write',
    description: 'Discard a draft. Confirm with the user before calling this.',
    inputSchema: {
      id: z.string().describe('The draft — the id from an earlier search_mail_drafts result'),
    },
    method: 'DELETE',
    path: '/v1/mail-drafts/:id',
    pathParams: { id: 'id' },
  },
];
