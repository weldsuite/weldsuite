/**
 * The mailbox store contract (design §2): what the Postgres implementation
 * (`store/postgres/*`, task B4) and the mailbox object's client
 * (`store/object/*`, task C2) both implement, and every input/output type a
 * caller needs to talk to either one. Types only — no implementations here.
 *
 * Scope note: this file covers the data-shape surface the design's §2 code
 * block lists under `MailboxStore`/`WorkspaceMailStore` plus their request
 * and result types. `MailAccess`, `WorkspaceMail`, `MailStoreEnv` and the
 * `getWorkspaceMail`/`createWorkspaceMail`/`readMailboxStoreMode`/
 * `mailboxStub` factory functions (design §2, §6) depend on the mailbox
 * object, the KV directory and the router, none of which exist yet — they
 * belong to the tasks that build those (C3, with B1/C1 for the object
 * itself), not to this one.
 */

import type { MailEmailAddress, MailDeliveryStatus, MailMessage } from '@weldsuite/db/schema/mail-messages';
import type { MailAttachment } from '@weldsuite/db/schema/mail-attachments';
import type { MailDraft } from '@weldsuite/db/schema/mail-drafts';
import type { MailSubscription, MailUnsubscribeMethod } from '@weldsuite/db/schema/mail-subscriptions';
import type { SubscriptionAggregate } from '@weldsuite/email/list-unsubscribe';
import type { MessageStats } from '../messages';
import type { ThreadListMessage, ThreadSummary } from '../threads';
import type { AttachmentInput } from '../attachments';
import type { DraftInput } from '../drafts';
import type { LocationLabel } from './model';

// ---------------------------------------------------------------------------
// Mode, ref
// ---------------------------------------------------------------------------

export const MAILBOX_STORE_FLAG = 'weldmail-mailbox-store';

export type MailStoreMode = 'postgres' | 'shadow' | 'object' | 'object-only';

export interface MailboxRef {
  /** `workspaces.id` (`ws_…`) — never the Clerk org id (ADR SEC-011). */
  workspaceId: string;
  accountId: string;
  clerkOrgId?: string | null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * The Postgres `mail_messages` row shape, in every mode. Bodies are only
 * populated on request (`getMessage(id, {bodies: true})`); fields the object
 * does not keep come back `null`.
 */
export type MailMessageRecord = Omit<MailMessage, 'textBody' | 'htmlBody' | 'rawMessage'> & {
  threadKey: string;
  textBody?: string | null;
  htmlBody?: string | null;
  rawMessage?: null;
};

/** The lean list row both stores return for a thread/message listing (phase 1's `ThreadListMessage`, plus the thread key). */
export type MailMessageListRow = ThreadListMessage & { threadKey: string };

/** `storagePath` stays server-side; this is the row as returned to a caller. */
export type MailAttachmentRecord = MailAttachment;

/** Lower-case: `'inbox'`, `'sent'`, …, `'__all'`, `'__total'`, `'__scheduled'`, or `lower(user label)`. */
export type FolderKey = string;

// ---------------------------------------------------------------------------
// Thread listing
// ---------------------------------------------------------------------------

export interface ThreadFilter {
  labelSlug: string;
  search?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  excludeWords?: string;
}

/** The unified-inbox position: one value shared across every mailbox (design §5), not one cursor per mailbox. */
export interface ThreadCursor {
  latestAt: number;
  accountId: string;
  threadKey: string;
}

export interface ThreadListQuery extends ThreadFilter {
  pageSize: number;
  cursor?: ThreadCursor | null;
  /** Legacy page/offset mode; capped at 5000 by the caller. */
  offset?: number;
  withMessages?: boolean;
}

export interface ThreadPage {
  threads: ThreadSummary[];
  totalCount: number;
  nextCursor: ThreadCursor | null;
}

// ---------------------------------------------------------------------------
// Message listing
// ---------------------------------------------------------------------------

export interface MessageCursor {
  sentAt: number;
  id: string;
}

export interface MessageListQuery {
  limit: number;
  cursor?: MessageCursor | null;
  search?: string;
  from?: string;
  label?: string;
  threadId?: string;
  isRead?: boolean;
  isStarred?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
  excludeTrash?: boolean;
  excludeSpam?: boolean;
  /** Exact address match — the CRM Emails tab. */
  counterparty?: string;
}

export interface MessagePage {
  data: MailMessageListRow[];
  totalCount: number;
  nextCursor: MessageCursor | null;
}

// ---------------------------------------------------------------------------
// Stats, snooze, subscriptions, drafts
// ---------------------------------------------------------------------------

export interface LabelCount {
  messages: number;
  unread: number;
  threads: number;
}

export interface MailboxStats extends MessageStats {
  labels: Record<FolderKey, LabelCount>;
}

export interface InboundThreadQuery {
  rfcMessageId: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  subject: string;
  fromEmail?: string | null;
  isReply: boolean;
}

export interface SnoozedMessage {
  id: string;
  accountId: string;
  subject: string | null;
  from: MailEmailAddress;
  snoozedUntil: string | null;
  snoozedAt: string | null;
  triggerRunId: string | null;
  createdAt: string | null;
}

/** The aggregate `scanSubscriptions`/the inbound worker upsert into `mail_subscriptions`. */
export type SubscriptionValues = SubscriptionAggregate;

// ---------------------------------------------------------------------------
// Writes: ingest
// ---------------------------------------------------------------------------

export interface IngestMessage {
  /** Generated by the writer before the first store write: the idempotency key. */
  id: string;
  source: 'inbound' | 'sent' | 'scheduled';
  rfcMessageId: string;
  externalMessageId?: string | null;
  providerMessageId?: string | null;
  /** From the primary; `null` + `threadHints` means the object resolves it. */
  threadId: string | null;
  threadHints?: InboundThreadQuery;
  from: MailEmailAddress;
  to: MailEmailAddress[];
  cc?: MailEmailAddress[] | null;
  bcc?: MailEmailAddress[] | null;
  replyTo?: MailEmailAddress | null;
  subject: string | null;
  preview: string | null;
  sentAt: number;
  receivedAt: number | null;
  createdAt: number;
  isRead: boolean;
  labels: string[];
  isSpam: boolean;
  inReplyTo?: string | null;
  references?: string[] | null;
  isReply: boolean;
  isForwarded?: boolean;
  priority?: string | null;
  sizeBytes?: number | null;
  spfStatus?: string | null;
  dkimStatus?: string | null;
  dmarcStatus?: string | null;
  sendStatus?: string | null;
  scheduledFor?: number | null;
  triggerRunId?: string | null;
  idempotencyKey?: string | null;
  delivery?: { status: MailDeliveryStatus; detail: string; at: number } | null;
  /** Worker-side only; never sent over RPC. */
  content?: { html?: string | null; text?: string | null };
  /** Presence bits, set by the object client after its R2 puts. */
  bodies?: { html: boolean; text: boolean; raw: boolean };
  /** ≤ 8 KB plain text for FTS. */
  searchText?: string;
  /** Objects already in R2. */
  attachments: Array<AttachmentInput & { id: string }>;
  /** Ham inbound with a `List-Unsubscribe` header. */
  subscription?: SubscriptionValues | null;
  extra?: Partial<Pick<MailMessage, 'headers' | 'customFields' | 'clickedLinks' | 'conversationId'>>;
}

// ---------------------------------------------------------------------------
// Writes: ops
// ---------------------------------------------------------------------------

export type FlagPatch = Partial<
  Record<'isRead' | 'isStarred' | 'isFlagged' | 'isImportant' | 'isSpam' | 'isTrash', boolean>
>;

/**
 * Every write is one op. Semantics mirror today's functions exactly
 * (`'single'` = `updateMessage`/`addMessageLabels`, `'bulk'` = `bulk*`).
 */
export type MailboxOp =
  | { kind: 'ingest'; message: IngestMessage }
  | { kind: 'flags'; ids: string[]; patch: FlagPatch; semantics: 'single' | 'bulk' }
  | { kind: 'labels.set'; id: string; labels: string[] }
  | { kind: 'labels.add' | 'labels.remove'; ids: string[]; labels: string[]; semantics: 'single' | 'bulk' }
  | { kind: 'move'; ids: string[]; location: LocationLabel }
  | { kind: 'thread.label'; threadKey: string; label: string; action: 'add' | 'remove' }
  | { kind: 'thread.read'; threadKey: string; isRead: boolean }
  | { kind: 'folder.read'; scope: ThreadFilter; batchSize?: number; maxBatches?: number; keepIds?: number }
  | { kind: 'thread.set'; id: string; threadId: string }
  | { kind: 'label.rename'; from: string; to: string }
  | { kind: 'label.delete'; name: string }
  | { kind: 'delete'; ids: string[]; hard?: boolean }
  | { kind: 'snooze' | 'resnooze'; id: string; until: number }
  | { kind: 'unsnooze'; id: string }
  | { kind: 'snooze.wake'; now: number }
  | {
      kind: 'scheduled';
      id: string;
      patch: {
        sendStatus?: 'scheduled' | 'sent' | 'cancelled' | 'failed';
        scheduledFor?: number | null;
        triggerRunId?: string | null;
        sentAt?: number;
        externalMessageId?: string;
        dropScheduledLabel?: boolean;
        softDelete?: boolean;
        delivery?: { status: MailDeliveryStatus; detail: string | null };
      };
    }
  | { kind: 'delivery.match'; recipient: string; eventAt: number; status: MailDeliveryStatus; detail: string | null }
  | {
      /**
       * A DELTA onto the row's CURRENT state, not an absolute snapshot: the
       * AI classification call this folds in (Jev) can take seconds, during
       * which a user can read, flag or archive the same message. `addLabels`/
       * `removeLabels` are merged onto whatever labels the row has when this
       * finally applies (same idempotent `addLabels`/`removeLabels` semantics
       * as `labels.add`/`labels.remove`); `isRead`/`isFlagged`/`isSpam`/
       * `deleted` are each applied ONLY when present — a rule that never
       * touched that field must leave it at whatever the user already set,
       * which is why these are optional rather than always-present booleans
       * (the bug this replaced: a caller that always sent `isRead: false`
       * could un-read mail a user had already opened).
       */
      kind: 'inbound.finalize';
      id: string;
      addLabels: string[];
      removeLabels: string[];
      isRead?: boolean;
      isFlagged?: boolean;
      isSpam?: boolean;
      deleted?: boolean;
    }
  | { kind: 'categories'; id: string; categories: string[]; important?: boolean }
  | { kind: 'attachment.create'; attachment: AttachmentInput & { id: string } }
  | { kind: 'attachment.update'; id: string; patch: Partial<AttachmentInput> }
  | { kind: 'attachment.delete'; id: string }
  | { kind: 'attachment.associate'; messageId: string; attachmentIds: string[] }
  | { kind: 'subscription.upsert'; values: SubscriptionValues[] }
  | {
      kind: 'subscription.status';
      id: string;
      patch: { status: 'unsubscribed'; method: MailUnsubscribeMethod; at: number; by: string };
    }
  | { kind: 'draft.create'; draft: DraftInput & { id: string } }
  | { kind: 'draft.update'; id: string; patch: Partial<DraftInput> }
  | { kind: 'draft.delete'; id: string };

export interface IngestResult {
  id: string;
  threadKey: string;
  created: boolean;
  duplicateOf?: string;
}

export interface OpResult {
  applied: string[];
  missing: string[];
  stale: string[];
  /** `folder.read`, `thread.read`, `thread.label`: every id, for the secondary store. */
  updatedIds?: string[];
  labels?: Record<string, string[]>;
  message?: MailMessageRecord | null;
  ingest?: IngestResult;
  storagePaths?: string[];
  /**
   * `folder.read` only: `true` when the last batch it ran was full-size, so
   * unread mail matching `scope` may remain beyond `maxBatches * batchSize` —
   * the caller (an alarm or route, task C1/C4) re-issues the same op to
   * continue. Resumable by construction (marked-read rows drop out of the
   * unread set the next SELECT sees), so no cursor needs to round-trip.
   */
  more?: boolean;
  /**
   * `snooze.wake` only: the next `snoozed_until` still pending after this
   * wake (or `null` for none), so the caller can schedule the mailbox's next
   * alarm (design §3.6) without a separate read.
   */
  nextSnoozeDueAt?: number | null;
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

export interface MailboxStore {
  readonly ref: MailboxRef;
  readonly backend: 'postgres' | 'object';

  // reads
  listThreads(q: ThreadListQuery): Promise<ThreadPage>;
  getThread(threadKey: string): Promise<{ threadId: string; accountId: string; messages: MailMessageRecord[] } | null>;
  getThreadOfMessage(messageId: string): Promise<{ threadId: string; messages: MailMessageRecord[] } | null>;
  getMessage(
    id: string,
    o?: { bodies?: boolean; attachments?: boolean },
  ): Promise<(MailMessageRecord & { attachments?: MailAttachmentRecord[] }) | null>;
  /**
   * Live rows in THIS mailbox (locate, bulk checks). `includeDeleted` also
   * returns a soft-deleted row — used ONLY to resolve a legacy pagination
   * cursor's sort position (the message it points at may have been deleted
   * since the page it came from was served), never to serve a deleted
   * message's content to a caller.
   */
  getMessages(ids: string[], opts?: { includeDeleted?: boolean }): Promise<MailMessageListRow[]>;
  /** Keyset `sentAt` desc, `id` desc; search is FTS in the object. */
  listMessages(q: MessageListQuery): Promise<MessagePage>;
  stats(): Promise<MailboxStats>;
  unreadCount(scope: 'inbox' | 'all-live'): Promise<number>;
  labelCounts(keys: FolderKey[]): Promise<Record<FolderKey, LabelCount>>;
  listAttachments(messageId: string): Promise<MailAttachmentRecord[]>;
  getAttachment(id: string): Promise<(MailAttachmentRecord & { accountId: string }) | null>;
  recentAttachments(q: {
    before?: { createdAt: number; id: string };
    limit: number;
  }): Promise<{ data: MailAttachmentRecord[]; totalCount: number }>;
  /** CRM recent correspondents. */
  recentAddresses(limit: number): Promise<string[]>;
  resolveInbound(q: InboundThreadQuery): Promise<{ duplicate: boolean; threadId: string; isExistingHamThread: boolean }>;
  findByRfcIds(
    ids: string[],
    providerIds: string[],
  ): Promise<Array<{ id: string; threadId: string | null; source: string | null }>>;
  findSentByIdempotencyKey(
    key: string,
  ): Promise<{ id: string; rfcMessageId: string; externalMessageId: string | null; subject: string | null } | null>;
  /** Deleted included, like today's `countSentToday`. */
  countSentSince(since: number): Promise<number>;
  listScheduled(): Promise<MailMessageRecord[]>;
  listSnoozed(): Promise<SnoozedMessage[]>;
  listSubscriptions(q: { status?: 'active' | 'unsubscribed' }): Promise<MailSubscription[]>;
  getSubscription(id: string): Promise<MailSubscription | null>;
  rawSources(q: {
    since: number;
    limit: number;
  }): Promise<Array<{ id: string; from: MailEmailAddress; subject: string | null; receivedAt: number }>>;
  listDrafts(q: {
    limit: number;
    cursor?: string;
  }): Promise<{ data: MailDraft[]; hasMore: boolean; cursor: string | null; totalCount: number }>;
  getDraft(id: string): Promise<MailDraft | null>;
  exportPage(q: {
    cursor?: string;
    limit: number;
    sentOnly?: boolean;
    since?: number;
    until?: number;
  }): Promise<{ data: MailMessageRecord[]; cursor: string | null }>;

  // writes
  /** `at` = the writer's clock (ms); the router supplies it. */
  apply(op: MailboxOp, at?: number): Promise<OpResult>;
  applyBatch(ops: MailboxOp[], at?: number): Promise<OpResult[]>;
}

export interface MarkFolderReadOptions {
  batchSize?: number;
  maxBatches?: number;
  updatedPerAccount?: number;
}

export interface WorkspaceMailStore {
  readonly workspaceId: string;
  readonly clerkOrgId: string;
  readonly mode: MailStoreMode;
  /** Routed: dual-write per mode (design §2.2). */
  mailbox(accountId: string): MailboxStore;
  /** Unified inbox. */
  listThreads(accountIds: string[], q: ThreadListQuery): Promise<ThreadPage>;
  listMessages(accountIds: string[], q: MessageListQuery): Promise<MessagePage>;
  stats(accountIds: string[]): Promise<MessageStats>;
  unreadBadge(accountIds: string[]): Promise<number>;
  /** `opts.includeDeleted`: see `MailboxStore.getMessages` — the legacy cursor resolution's use case. */
  locateMessages(
    ids: string[],
    accountIds: string[],
    hint?: string,
    opts?: { includeDeleted?: boolean },
  ): Promise<Map<string, string>>;
  locateAttachment(
    id: string,
    accountIds: string[],
    hint?: string,
  ): Promise<{ accountId: string; attachment: MailAttachmentRecord } | null>;
  locateDraft(id: string, accountIds: string[], hint?: string): Promise<{ accountId: string; draft: MailDraft } | null>;
  /** Exact address match: the CRM Emails tab. */
  messagesByCounterparty(
    address: string,
    accountIds: string[],
    q: { cursor?: MessageCursor; limit: number },
  ): Promise<MessagePage>;
  recentAttachments(
    accountIds: string[],
    q: { limit: number },
  ): Promise<{ data: Array<MailAttachmentRecord & { accountId: string }>; totalCount: number }>;
  /** AI context. */
  recentMessages(accountIds: string[], limit: number): Promise<MailMessageListRow[]>;
  markFolderRead(
    accountIds: string[],
    scope: ThreadFilter,
    o?: MarkFolderReadOptions,
  ): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[] }>;
  listSnoozed(accountIds: string[]): Promise<SnoozedMessage[]>;
  listScheduled(accountIds: string[]): Promise<MailMessageRecord[]>;
  listDrafts(
    accountIds: string[],
    q: { limit: number; cursor?: string },
  ): Promise<{ data: MailDraft[]; hasMore: boolean; cursor: string | null; totalCount: number }>;
}
