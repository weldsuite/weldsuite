import { z } from 'zod';

// ============================================================================
// WeldChat entity channels ("record chats") — lets any business record
// (company, person, task, project, domain, sheet, document) have its own chat
// channel. The
// channel is created lazily on the first message via
// POST /:entityType/:entityId/messages (or on the first follow).
//
// Backed by `chat_channels` (type = 'entity') + `chat_channel_members`. A
// membership row means the user FOLLOWS the chat (sidebar, unread state,
// notifications).
// Permission prefix: `channels:*` (read) / `messages:*` (post), plus the
// record type's own read permission (e.g. `companies:read`).
// ============================================================================

export const sendEntityMessageSchema = z.object({
  content: z.string().min(1),
  htmlContent: z.string().optional(),
  parentId: z.string().nullish(),
  mentions: z.array(z.string()).optional(),
  mentionsEveryone: z.boolean().optional(),
  attachments: z.array(z.record(z.any())).optional(),
  metadata: z.record(z.any()).optional(),
});

export type SendEntityMessageInput = z.infer<typeof sendEntityMessageSchema>;

/** Record chat types, in sidebar group order. */
export const RECORD_CHAT_TYPES = ['company', 'person', 'task', 'project', 'domain', 'sheet', 'doc', 'board'] as const;
export type RecordChatType = (typeof RECORD_CHAT_TYPES)[number];

/**
 * The record chats of WeldBooks' records (Rust backend only, edition feature
 * `books-questions`; ADR BOOKS-015). Not in {@link RECORD_CHAT_TYPES}: Global's
 * chat-api has no provider for them. `accounting_contact` is a WeldBooks contact.
 */
export const BOOKS_RECORD_CHAT_TYPES = [
  'invoice',
  'bill',
  'bank_transaction',
  'accounting_document',
  'vat_return',
  'accounting_contact',
] as const;
export type BooksRecordChatType = (typeof BOOKS_RECORD_CHAT_TYPES)[number];

/** A question's status: `metadata.question.status` of the thread's first message. */
export const QUESTION_STATUSES = ['open', 'answered', 'resolved'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** POST /api/accounting-questions */
export const askQuestionSchema = z.object({
  recordType: z.enum(BOOKS_RECORD_CHAT_TYPES),
  recordId: z.string().min(1).max(255),
  text: z.string().min(1).max(10_000),
  /** Member (user) ids the question is for; they follow the record's chat. */
  askedTo: z.array(z.string()).max(20).optional(),
});
export type AskQuestionInput = z.infer<typeof askQuestionSchema>;

/** POST /api/accounting-questions/bulk */
export const askQuestionsBulkSchema = z.object({
  recordType: z.enum(BOOKS_RECORD_CHAT_TYPES),
  recordIds: z.array(z.string().min(1)).min(1).max(100),
  text: z.string().min(1).max(10_000),
  askedTo: z.array(z.string()).max(20).optional(),
});
export type AskQuestionsBulkInput = z.infer<typeof askQuestionsBulkSchema>;

/** PATCH /api/accounting-questions/:messageId */
export const setQuestionStatusSchema = z.object({ status: z.enum(QUESTION_STATUSES) });
export type SetQuestionStatusInput = z.infer<typeof setQuestionStatusSchema>;

/**
 * `following`: chats the caller follows. `unread`: followed, not muted, with
 * messages after the caller's read marker. `mentions`: followed, with unread
 * @mentions. `all`: every record chat the caller may read.
 */
export const RECORD_CHAT_FILTERS = ['following', 'unread', 'mentions', 'all'] as const;
export type RecordChatFilter = (typeof RECORD_CHAT_FILTERS)[number];

/**
 * `recent`: most recent activity first (the sidebar). `unread`: the chats
 * unread to the caller (as in the `unread` filter) first, each part most
 * recent first (the record chats page).
 */
export const RECORD_CHAT_SORTS = ['recent', 'unread'] as const;
export type RecordChatSort = (typeof RECORD_CHAT_SORTS)[number];

/** GET /api/chat-entity-channels */
export const listEntityChannelsQuerySchema = z.object({
  type: z.string().min(1).max(50).optional(),
  filter: z.enum(RECORD_CHAT_FILTERS).default('following'),
  sort: z.enum(RECORD_CHAT_SORTS).default('recent'),
  search: z.string().trim().max(200).optional(),
  /** The id of the last chat on the previous page. */
  cursor: z.string().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListEntityChannelsQuery = z.input<typeof listEntityChannelsQuerySchema>;

/**
 * Where a comment thread is in its record, on the thread's first message
 * (`metadata.anchor`). The record keeps the thread under `id` (on a
 * spreadsheet cell, a stretch of a document's text) and moves it as the
 * record changes; `label` says where it was when written ("Sheet1!B7"),
 * `quote` the text it is about. Replies are ordinary thread replies.
 */
export const recordCommentAnchorSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(200).optional(),
  quote: z.string().max(2000).optional(),
});

export type RecordCommentAnchor = z.infer<typeof recordCommentAnchorSchema>;

/** PATCH /api/chat-entity-channels/:entityType/mute */
export const muteRecordChatsSchema = z.object({
  isMuted: z.boolean(),
});

export type MuteRecordChatsInput = z.infer<typeof muteRecordChatsSchema>;

/** The caller's own state on one record chat (absent membership = not following). */
export interface RecordChatCallerState {
  isFollowing: boolean;
  isMuted: boolean;
  lastReadAt: string | null;
  lastReadMessageId: string | null;
  unreadMentionCount: number;
}

/** One row of GET /api/chat-entity-channels/summary. */
export interface RecordChatTypeSummary {
  type: string;
  label: string;
  /** Chats of this type the caller follows. */
  followed: number;
  /** Followed, not muted chats with messages after the caller's read marker. */
  unread: number;
  /** Unread @mentions across the followed chats (muted ones included). */
  mentions: number;
}
