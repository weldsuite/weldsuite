/**
 * `PostgresWorkspaceMailStore`: the Postgres implementation of
 * `WorkspaceMailStore` (design task B4, §2.1) — the cross-mailbox reads
 * (unified thread list, stats, unread badge, counterparty messages, locate*,
 * recent*, snoozed/scheduled/drafts lists), answered with single SQL queries
 * over `accountIds`, as today — no per-mailbox fan-out and merge (that is the
 * mailbox object's job, design §5).
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { inTrashOrSpamCondition } from '../../labels';
import { getMessageStats, listMessagesWide, type MessageStats } from '../../messages';
import { listThreadsForAccounts } from '../../threads';
import { listSnoozedMessages } from '../../snooze';
import { markFolderReadForAccounts } from '../../thread-ops';
import { listDrafts as listDraftRows } from '../../drafts';
import { listScheduled as listScheduledRows } from './scheduled';
import { PostgresMailboxStore } from './mailbox-store';
import type {
  MailAttachmentRecord,
  MailboxStore,
  MailMessageListRow,
  MailMessageRecord,
  MarkFolderReadOptions,
  MessageCursor,
  MessageListQuery,
  MessagePage,
  SnoozedMessage,
  ThreadCursor,
  ThreadFilter,
  ThreadListQuery,
  ThreadPage,
  WorkspaceMailStore,
} from '../types';

const { mailAttachments, mailDrafts, mailMessages } = schema;

// The explicit `textBody`/`htmlBody`/`rawMessage` fields below override whatever
// `row` itself carried for them, so there is no need to destructure them out first.
function toMessageRecord(row: typeof mailMessages.$inferSelect): MailMessageRecord {
  return { ...row, threadKey: row.threadId ?? row.id, textBody: row.textBody ?? null, htmlBody: row.htmlBody ?? null, rawMessage: null };
}

export class PostgresWorkspaceMailStore implements WorkspaceMailStore {
  readonly mode = 'postgres' as const;

  constructor(
    private readonly db: Database,
    readonly workspaceId: string,
    readonly clerkOrgId: string,
  ) {}

  mailbox(accountId: string): MailboxStore {
    return new PostgresMailboxStore(this.db, { workspaceId: this.workspaceId, accountId, clerkOrgId: this.clerkOrgId });
  }

  async listThreads(accountIds: string[], q: ThreadListQuery): Promise<ThreadPage> {
    if (accountIds.length === 0) return { threads: [], totalCount: 0, nextCursor: null };
    const cursor = q.cursor
      ? { latestAt: new Date(q.cursor.latestAt), accountId: q.cursor.accountId, threadKey: q.cursor.threadKey }
      : undefined;
    const { threads, totalCount } = await listThreadsForAccounts(this.db, accountIds, {
      labelSlug: q.labelSlug,
      search: q.search,
      from: q.from,
      to: q.to,
      subject: q.subject,
      hasAttachment: q.hasAttachment,
      excludeWords: q.excludeWords,
      pageSize: q.pageSize + 1,
      offset: q.offset,
      cursor,
    });
    const hasMore = threads.length > q.pageSize;
    const page = hasMore ? threads.slice(0, q.pageSize) : threads;
    const last = page.at(-1);
    const nextCursor: ThreadCursor | null =
      hasMore && last
        ? { latestAt: (last.latestDate ?? new Date(0)).getTime(), accountId: last.accountId, threadKey: last.threadId }
        : null;
    return { threads: page, totalCount, nextCursor };
  }

  async listMessages(accountIds: string[], q: MessageListQuery): Promise<MessagePage> {
    if (accountIds.length === 0) return { data: [], totalCount: 0, nextCursor: null };
    return this.messagePage(accountIds, q);
  }

  async stats(accountIds: string[]): Promise<MessageStats> {
    return getMessageStats(this.db, accountIds);
  }

  async unreadBadge(accountIds: string[]): Promise<number> {
    if (accountIds.length === 0) return 0;
    const [row] = await this.db
      .select({
        count: sql<number>`count(*) FILTER (WHERE NOT ${inTrashOrSpamCondition()} AND ${mailMessages.isRead} = false)::int`,
      })
      .from(mailMessages)
      .where(and(inArray(mailMessages.accountId, accountIds), isNull(mailMessages.deletedAt)));
    return Number(row?.count ?? 0);
  }

  async locateMessages(ids: string[], accountIds: string[]): Promise<Map<string, string>> {
    if (ids.length === 0 || accountIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: mailMessages.id, accountId: mailMessages.accountId })
      .from(mailMessages)
      .where(and(inArray(mailMessages.id, ids), inArray(mailMessages.accountId, accountIds), isNull(mailMessages.deletedAt)));
    return new Map(rows.map((r) => [r.id, r.accountId]));
  }

  async locateAttachment(
    id: string,
    accountIds: string[],
  ): Promise<{ accountId: string; attachment: MailAttachmentRecord } | null> {
    if (accountIds.length === 0) return null;
    const [row] = await this.db
      .select({ attachment: mailAttachments, accountId: mailMessages.accountId })
      .from(mailAttachments)
      .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
      .where(
        and(
          eq(mailAttachments.id, id),
          isNull(mailAttachments.deletedAt),
          // An attachment of a soft-deleted message is not reachable either —
          // the message's own soft delete must 404 it, same as the message itself.
          isNull(mailMessages.deletedAt),
          inArray(mailMessages.accountId, accountIds),
        ),
      )
      .limit(1);
    if (!row) return null;
    return { accountId: row.accountId, attachment: row.attachment };
  }

  async locateDraft(id: string, accountIds: string[]) {
    if (accountIds.length === 0) return null;
    const [row] = await this.db
      .select()
      .from(mailDrafts)
      .where(and(eq(mailDrafts.id, id), isNull(mailDrafts.deletedAt), inArray(mailDrafts.accountId, accountIds)))
      .limit(1);
    if (!row) return null;
    return { accountId: row.accountId, draft: row };
  }

  async messagesByCounterparty(
    address: string,
    accountIds: string[],
    q: { cursor?: MessageCursor; limit: number },
  ): Promise<MessagePage> {
    if (accountIds.length === 0) return { data: [], totalCount: 0, nextCursor: null };
    return this.messagePage(accountIds, { limit: q.limit, cursor: q.cursor, counterparty: address });
  }

  private async messagePage(
    accountIds: string[],
    q: Pick<
      MessageListQuery,
      | 'limit'
      | 'cursor'
      | 'search'
      | 'from'
      | 'label'
      | 'threadId'
      | 'isRead'
      | 'isStarred'
      | 'isFlagged'
      | 'hasAttachments'
      | 'excludeTrash'
      | 'excludeSpam'
      | 'counterparty'
    >,
  ): Promise<MessagePage> {
    const result = await listMessagesWide(this.db, {
      accessibleAccountIds: accountIds,
      limit: q.limit,
      cursorValue: q.cursor ? { sentDate: new Date(q.cursor.sentAt), id: q.cursor.id } : undefined,
      search: q.search,
      from: q.from,
      label: q.label,
      threadId: q.threadId,
      isRead: q.isRead,
      isStarred: q.isStarred,
      isFlagged: q.isFlagged,
      hasAttachments: q.hasAttachments,
      excludeTrash: q.excludeTrash,
      excludeSpam: q.excludeSpam,
      counterparty: q.counterparty,
    });
    const data: MailMessageListRow[] = result.data.map((r) => ({ ...r, threadKey: r.threadId ?? r.id }));
    const last = data.at(-1);
    const nextCursor: MessageCursor | null = result.hasMore && last ? { sentAt: last.sentDate!.getTime(), id: last.id } : null;
    return { data, totalCount: result.totalCount, nextCursor };
  }

  async recentAttachments(
    accountIds: string[],
    q: { limit: number },
  ): Promise<{ data: Array<MailAttachmentRecord & { accountId: string }>; totalCount: number }> {
    if (accountIds.length === 0) return { data: [], totalCount: 0 };
    const where = and(
      inArray(mailMessages.accountId, accountIds),
      isNull(mailAttachments.deletedAt),
      eq(mailAttachments.isInline, false),
    );
    const [rows, countRows] = await Promise.all([
      this.db
        .select({ attachment: mailAttachments, accountId: mailMessages.accountId })
        .from(mailAttachments)
        .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
        .where(where)
        .orderBy(desc(mailAttachments.createdAt), desc(mailAttachments.id))
        .limit(q.limit),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(mailAttachments)
        .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
        .where(where),
    ]);
    return { data: rows.map((r) => ({ ...r.attachment, accountId: r.accountId })), totalCount: Number(countRows[0]?.count ?? 0) };
  }

  async recentMessages(accountIds: string[], limit: number): Promise<MailMessageListRow[]> {
    if (accountIds.length === 0) return [];
    const result = await listMessagesWide(this.db, { accessibleAccountIds: accountIds, limit });
    return result.data.map((r) => ({ ...r, threadKey: r.threadId ?? r.id }));
  }

  async markFolderRead(
    accountIds: string[],
    scope: ThreadFilter,
    o?: MarkFolderReadOptions,
  ): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[] }> {
    if (accountIds.length === 0) return { updatedCount: 0, updated: [] };
    return markFolderReadForAccounts(this.db, accountIds, scope, o);
  }

  async listSnoozed(accountIds: string[]): Promise<SnoozedMessage[]> {
    if (accountIds.length === 0) return [];
    return listSnoozedMessages(this.db, { accountIds });
  }

  async listScheduled(accountIds: string[]): Promise<MailMessageRecord[]> {
    if (accountIds.length === 0) return [];
    const rows = await listScheduledRows(this.db, accountIds);
    return rows.map(toMessageRecord);
  }

  async listDrafts(accountIds: string[], q: { limit: number; cursor?: string }) {
    if (accountIds.length === 0) return { data: [], hasMore: false, cursor: null, totalCount: 0 };
    return listDraftRows(this.db, { accessibleAccountIds: accountIds, limit: q.limit, cursor: q.cursor });
  }
}
