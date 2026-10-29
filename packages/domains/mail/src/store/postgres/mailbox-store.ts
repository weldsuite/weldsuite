/**
 * `PostgresMailboxStore`: the Postgres implementation of `MailboxStore`
 * (design task B4, docs/plans/weldmail-mailbox-store-design.md §2.1).
 *
 * Wraps today's functions (`../../threads`, `../../messages`, `../../labels`,
 * `../../snooze`, `../../thread-ops`, `../../attachments`, `../../drafts`) and
 * the new `./inbound`, `./scheduled`, `./subscriptions` helpers. In `postgres`
 * mode the router calls only this, so every read must return the same rows,
 * order, pagination semantics and errors today's routes do — no behaviour
 * change. `apply`/`applyBatch` map a `MailboxOp` onto the same write
 * functions; see the design's §2.2 "Making the secondary deterministic" for
 * why `applied`/`missing`/`stale` are reported the way they are below.
 */

import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailDeliveryStatus, MailMessage } from '@weldsuite/db/schema/mail-messages';
import {
  applyLabelToThread,
  archivedCondition,
  canonicalLabelNames,
  inTrashOrSpamCondition,
  labelCondition,
  moveMessagesToLocation,
  bulkAddLabelToMessages,
  bulkRemoveLabelFromMessages,
  relabelMessages,
  stripLabelFromMessages,
  SYSTEM_LABELS,
  toSystemLabel,
} from '../../labels';
import { normalizeLabel, type LocationLabel } from '../model';
import {
  addMessageLabels,
  enrichSenderContacts,
  getLiveMessagesByIds,
  getMessage as getMessageRow,
  getMessageStats,
  getThread as getMessageThread,
  listMessagesWide,
  removeMessageLabels,
  softDeleteMessage,
  updateMessage,
} from '../../messages';
import { getThreadByKey, listThreadsForAccounts, type ThreadListMessage } from '../../threads';
import {
  listSnoozedMessages,
  MailSnoozeError,
  nextSnoozeDueAt,
  resnoozeMessage,
  snoozeMessage,
  unsnoozeMessage,
  wakeDueSnoozedMessages,
} from '../../snooze';
import { markFolderReadForAccounts, markThreadRead } from '../../thread-ops';
import {
  createAttachment,
  listAttachmentsForMessage,
  associateAttachments,
  softDeleteAttachmentRow,
  updateAttachment,
} from '../../attachments';
import { createDraft, getDraft as getDraftRow, listDrafts as listDraftRows, softDeleteDraft, updateDraft } from '../../drafts';
import {
  countSentSince as countSentSinceRow,
  findByRfcIds as findByRfcIdsRows,
  findSentByIdempotencyKey as findSentByIdempotencyKeyRow,
  resolveInbound as resolveInboundThread,
} from './inbound';
import { applyScheduledPatch, listScheduled as listScheduledRows } from './scheduled';
import {
  getSubscription as getSubscriptionRow,
  listSubscriptions as listSubscriptionsRows,
  rawSources as rawSourcesRows,
  reconcileSubscriptions,
  updateSubscriptionStatus,
  upsertSubscriptionOnMessage,
} from './subscriptions';
import type {
  FlagPatch,
  FolderKey,
  IngestMessage,
  IngestResult,
  InboundThreadQuery,
  LabelCount,
  MailAttachmentRecord,
  MailboxOp,
  MailboxRef,
  MailboxStats,
  MailboxStore,
  MailMessageListRow,
  MailMessageRecord,
  MessageCursor,
  MessageListQuery,
  MessagePage,
  OpResult,
  SnoozedMessage,
  ThreadCursor,
  ThreadListQuery,
  ThreadPage,
} from '../types';

const { mailAttachments, mailLabels, mailMessages } = schema;

/** Trash/spam-match delivery rank (ported from `outbound/delivery-events.ts`'s module-private `STATUS_RANK`; kept in step by hand). */
const DELIVERY_STATUS_RANK: Record<MailDeliveryStatus, number> = {
  deferred: 0,
  delivered: 1,
  failed: 2,
  rejected: 2,
  bounced: 3,
  complained: 4,
};

/** `mail_messages.priority`'s enum values (schema `mailPriorityEnum`), kept here since `IngestMessage.priority` is a looser `string` than the column. */
const MAIL_PRIORITY_VALUES = ['highest', 'high', 'normal', 'low', 'lowest'] as const;
type MailPriorityValue = (typeof MAIL_PRIORITY_VALUES)[number];

/** An ingest message's free-form priority string, narrowed to the enum column — anything else (or absent) leaves the column at its default. */
function toPriorityValue(priority: string | null | undefined): MailPriorityValue | undefined {
  return priority && (MAIL_PRIORITY_VALUES as readonly string[]).includes(priority) ? (priority as MailPriorityValue) : undefined;
}

/** `mail_messages.{spf,dkim,dmarc}_status`'s enum values (schema `mailSecurityStatusEnum`), same looseness as priority above. */
const MAIL_SECURITY_STATUS_VALUES = ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror'] as const;
type MailSecurityStatusValue = (typeof MAIL_SECURITY_STATUS_VALUES)[number];

function toSecurityStatusValue(status: string | null | undefined): MailSecurityStatusValue | undefined {
  return status && (MAIL_SECURITY_STATUS_VALUES as readonly string[]).includes(status)
    ? (status as MailSecurityStatusValue)
    : undefined;
}

/**
 * Every `mail_messages` row to the store's contract shape: `threadKey` added,
 * `rawMessage` always null, bodies stripped unless asked for. The explicit
 * `textBody`/`htmlBody`/`rawMessage` fields below override whatever `row`
 * itself carried for them, so there is no need to destructure them out first.
 */
function toMessageRecord(row: MailMessage, o: { bodies: boolean } = { bodies: false }): MailMessageRecord {
  return {
    ...row,
    threadKey: row.threadId ?? row.id,
    textBody: o.bodies ? (row.textBody ?? null) : undefined,
    htmlBody: o.bodies ? (row.htmlBody ?? null) : undefined,
    rawMessage: null,
  };
}

function toListRow(row: ThreadListMessage): MailMessageListRow {
  return { ...row, threadKey: row.threadId ?? row.id };
}

/**
 * The WHERE condition for whether a live message belongs to `key`, mirroring
 * `store/model.ts`'s `folderKeys` pure rule in the opposite direction (given a
 * key, not given a message). Kept in lockstep by hand, same as that file
 * documents for the mailbox object's derived tables.
 *
 * `customNames` is the custom label's stored casing(s) (from `mail_labels`,
 * resolved by {@link resolveCustomLabelNamesForKeys}) — without it, a label
 * registered as e.g. "Invoices" only ever matches the lower-cased slug
 * "invoices" and never the casing actually written to `mail_messages.labels`,
 * same resolution `threadListScope` already does for `listThreads` (`../../
 * labels.ts`'s `labelCondition`'s own `customNames` parameter).
 */
function folderKeyCondition(key: FolderKey, customNames: string[] = []): SQL {
  const lower = key.toLowerCase();
  if (lower === '__total') return sql`true`;
  if (lower === '__all') return sql`NOT ${inTrashOrSpamCondition()}`;
  if (lower === '__scheduled') {
    return sql`${labelCondition('SCHEDULED')} AND ${mailMessages.sendStatus} = 'scheduled' AND NOT ${inTrashOrSpamCondition()}`;
  }
  const system = toSystemLabel(lower);
  if (system === SYSTEM_LABELS.TRASH || system === SYSTEM_LABELS.SPAM) return labelCondition(lower);
  if (system) return sql`${labelCondition(lower)} AND NOT ${inTrashOrSpamCondition()}`;
  return sql`${labelCondition(lower, customNames)} AND NOT ${inTrashOrSpamCondition()} AND NOT ${archivedCondition()}`;
}

/** `folderKeyCondition`'s pseudo-keys and system-label slugs — never a custom label's own name, so never worth a `mail_labels` lookup. */
function isNonCustomFolderKey(key: FolderKey): boolean {
  const lower = key.toLowerCase();
  return lower === '__total' || lower === '__all' || lower === '__scheduled' || toSystemLabel(lower) !== null;
}

/**
 * Resolves every non-system key in `keys` against `mail_labels` in ONE query
 * (keyed by the key's lower-case form, since several keys could normalise to
 * the same registered label), the batched twin of `../../labels.ts`'s
 * `resolveCustomLabelNames` for `labelCounts`/`stats()` — which ask about many
 * keys at once, unlike `listThreads`'s single label slug.
 */
async function resolveCustomLabelNamesForKeys(
  db: Database,
  accountId: string,
  keys: FolderKey[],
): Promise<Map<string, string[]>> {
  const customKeys = [...new Set(keys.filter((k) => !isNonCustomFolderKey(k)).map((k) => k.toLowerCase()))];
  const byKey = new Map<string, string[]>();
  if (customKeys.length === 0) return byKey;
  const rows = await db
    .selectDistinct({ name: mailLabels.name })
    .from(mailLabels)
    .where(
      and(
        eq(mailLabels.accountId, accountId),
        isNull(mailLabels.deletedAt),
        inArray(sql`LOWER(${mailLabels.name})`, customKeys),
      ),
    );
  for (const row of rows) {
    const lower = row.name.toLowerCase();
    const names = byKey.get(lower) ?? [];
    names.push(row.name);
    byKey.set(lower, names);
  }
  return byKey;
}

export class PostgresMailboxStore implements MailboxStore {
  readonly backend = 'postgres' as const;

  constructor(
    private readonly db: Database,
    readonly ref: MailboxRef,
  ) {}

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async listThreads(q: ThreadListQuery): Promise<ThreadPage> {
    const accountId = this.ref.accountId;
    const cursor = q.cursor
      ? { latestAt: new Date(q.cursor.latestAt), accountId: q.cursor.accountId, threadKey: q.cursor.threadKey }
      : undefined;
    // Over-fetch by one so `hasMore`/`nextCursor` can be computed without a
    // second round trip (the keyset equivalent of `listMessages`'s `limit+1`).
    const { threads, totalCount } = await listThreadsForAccounts(this.db, [accountId], {
      labelSlug: q.labelSlug,
      accountId,
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
      hasMore && last ? { latestAt: (last.latestDate ?? new Date(0)).getTime(), accountId, threadKey: last.threadId } : null;
    return { threads: page, totalCount, nextCursor };
  }

  async getThread(threadKey: string) {
    const result = await getThreadByKey(this.db, this.ref.accountId, threadKey);
    if (!result) return null;
    await enrichSenderContacts(this.db, result.messages);
    return {
      threadId: result.threadId,
      accountId: result.accountId,
      messages: result.messages.map((m) => toMessageRecord(m, { bodies: true })),
    };
  }

  async getThreadOfMessage(messageId: string) {
    const result = await getMessageThread(this.db, messageId);
    if (!result) return null;
    return { threadId: result.threadId, messages: result.messages.map((m) => toMessageRecord(m, { bodies: true })) };
  }

  async getMessage(id: string, o?: { bodies?: boolean; attachments?: boolean }) {
    const row = await getMessageRow(this.db, id);
    if (!row || row.accountId !== this.ref.accountId) return null;
    const record: MailMessageRecord & { attachments?: MailAttachmentRecord[] } = toMessageRecord(row, {
      bodies: o?.bodies ?? false,
    });
    if (o?.attachments) record.attachments = row.attachments;
    return record;
  }

  async getMessages(ids: string[]): Promise<MailMessageListRow[]> {
    const rows = await getLiveMessagesByIds(this.db, this.ref.accountId, ids);
    return rows.map(toListRow);
  }

  async listMessages(q: MessageListQuery): Promise<MessagePage> {
    const result = await listMessagesWide(this.db, {
      accountId: this.ref.accountId,
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
    const data = result.data.map(toListRow);
    const last = data.at(-1);
    const nextCursor: MessageCursor | null =
      result.hasMore && last ? { sentAt: last.sentDate!.getTime(), id: last.id } : null;
    return { data, totalCount: result.totalCount, nextCursor };
  }

  async stats(): Promise<MailboxStats> {
    const base = await getMessageStats(this.db, this.ref.accountId);
    const customLabels = await this.db
      .select({ name: mailLabels.name })
      .from(mailLabels)
      .where(
        and(
          eq(mailLabels.accountId, this.ref.accountId),
          isNull(mailLabels.deletedAt),
          sql`${mailLabels.isSystem} IS NOT TRUE`,
        ),
      );
    const keys: FolderKey[] = [
      '__total',
      '__all',
      '__scheduled',
      ...Object.values(SYSTEM_LABELS).map((l) => l.toLowerCase()),
      ...customLabels.map((l) => l.name.toLowerCase()),
    ];
    const labels = await this.labelCounts([...new Set(keys)]);
    return { ...base, labels };
  }

  async unreadCount(scope: 'inbox' | 'all-live'): Promise<number> {
    const live = sql`NOT ${inTrashOrSpamCondition()}`;
    const condition = scope === 'inbox' ? sql`${labelCondition('INBOX')} AND ${live}` : live;
    const [row] = await this.db
      .select({ count: sql<number>`count(*) FILTER (WHERE ${condition} AND ${mailMessages.isRead} = false)::int` })
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, this.ref.accountId), isNull(mailMessages.deletedAt)));
    return Number(row?.count ?? 0);
  }

  async labelCounts(keys: FolderKey[]): Promise<Record<FolderKey, LabelCount>> {
    if (keys.length === 0) return {};
    const customNames = await resolveCustomLabelNamesForKeys(this.db, this.ref.accountId, keys);
    const selection: Record<string, SQL.Aliased<number>> = {};
    keys.forEach((key, i) => {
      const condition = folderKeyCondition(key, customNames.get(key.toLowerCase()) ?? []);
      selection[`m${i}`] = sql<number>`count(*) FILTER (WHERE ${condition})::int`.as(`m${i}`);
      selection[`u${i}`] = sql<number>`count(*) FILTER (WHERE ${condition} AND ${mailMessages.isRead} = false)::int`.as(
        `u${i}`,
      );
      selection[`t${i}`] =
        sql<number>`count(DISTINCT CASE WHEN ${condition} THEN COALESCE(${mailMessages.threadId}, ${mailMessages.id}) END)::int`.as(
          `t${i}`,
        );
    });
    const [row] = await this.db
      .select(selection)
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, this.ref.accountId), isNull(mailMessages.deletedAt)));
    const counted = (row ?? {}) as Record<string, number>;
    const result: Record<FolderKey, LabelCount> = {};
    keys.forEach((key, i) => {
      result[key] = {
        messages: counted[`m${i}`] ?? 0,
        unread: counted[`u${i}`] ?? 0,
        threads: counted[`t${i}`] ?? 0,
      };
    });
    return result;
  }

  async listAttachments(messageId: string): Promise<MailAttachmentRecord[]> {
    return listAttachmentsForMessage(this.db, messageId);
  }

  async getAttachment(id: string): Promise<(MailAttachmentRecord & { accountId: string }) | null> {
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
          eq(mailMessages.accountId, this.ref.accountId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return { ...row.attachment, accountId: row.accountId };
  }

  async recentAttachments(q: {
    before?: { createdAt: number; id: string };
    limit: number;
  }): Promise<{ data: MailAttachmentRecord[]; totalCount: number }> {
    const conditions = [
      eq(mailMessages.accountId, this.ref.accountId),
      isNull(mailAttachments.deletedAt),
      eq(mailAttachments.isInline, false),
    ];
    if (q.before) {
      const beforeDate = new Date(q.before.createdAt);
      conditions.push(
        sql`(${mailAttachments.createdAt} < ${beforeDate} OR (${mailAttachments.createdAt} = ${beforeDate} AND ${mailAttachments.id} < ${q.before.id}))`,
      );
    }
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      this.db
        .select({ attachment: mailAttachments })
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
    return { data: rows.map((r) => r.attachment), totalCount: Number(countRows[0]?.count ?? 0) };
  }

  async recentAddresses(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ fromEmail: sql<string | null>`(${mailMessages.from}->>'email')`, toEmails: mailMessages.to })
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, this.ref.accountId), isNull(mailMessages.deletedAt)))
      .orderBy(desc(mailMessages.sentDate))
      .limit(200);
    const set = new Set<string>();
    for (const row of rows) {
      if (row.fromEmail) set.add(row.fromEmail.trim().toLowerCase());
      if (Array.isArray(row.toEmails)) {
        for (const addr of row.toEmails as Array<{ email?: string }>) {
          if (addr?.email) set.add(addr.email.trim().toLowerCase());
        }
      }
    }
    return [...set].slice(0, limit);
  }

  async resolveInbound(q: InboundThreadQuery) {
    return resolveInboundThread(this.db, this.ref.accountId, q);
  }

  async findByRfcIds(ids: string[], providerIds: string[]) {
    return findByRfcIdsRows(this.db, this.ref.accountId, ids, providerIds);
  }

  async findSentByIdempotencyKey(key: string) {
    return findSentByIdempotencyKeyRow(this.db, this.ref.accountId, key);
  }

  async countSentSince(since: number): Promise<number> {
    return countSentSinceRow(this.db, this.ref.accountId, since);
  }

  async listScheduled(): Promise<MailMessageRecord[]> {
    const rows = await listScheduledRows(this.db, this.ref.accountId);
    return rows.map((r) => toMessageRecord(r, { bodies: true }));
  }

  async listSnoozed(): Promise<SnoozedMessage[]> {
    return listSnoozedMessages(this.db, { accountId: this.ref.accountId });
  }

  async listSubscriptions(q: { status?: 'active' | 'unsubscribed' }) {
    return listSubscriptionsRows(this.db, this.ref.accountId, q.status);
  }

  async getSubscription(id: string) {
    const row = await getSubscriptionRow(this.db, id);
    return row && row.accountId === this.ref.accountId ? row : null;
  }

  async rawSources(q: { since: number; limit: number }) {
    return rawSourcesRows(this.db, this.ref.accountId, q);
  }

  async listDrafts(q: { limit: number; cursor?: string }) {
    return listDraftRows(this.db, { accountId: this.ref.accountId, limit: q.limit, cursor: q.cursor });
  }

  async getDraft(id: string) {
    const row = await getDraftRow(this.db, id);
    return row && row.accountId === this.ref.accountId ? row : null;
  }

  async exportPage(q: { cursor?: string; limit: number; sentOnly?: boolean; since?: number; until?: number }) {
    const conditions = [eq(mailMessages.accountId, this.ref.accountId)];
    if (q.sentOnly) conditions.push(eq(mailMessages.source, 'sent'));
    if (q.since !== undefined) conditions.push(gte(mailMessages.createdAt, new Date(q.since)));
    if (q.until !== undefined) conditions.push(lte(mailMessages.createdAt, new Date(q.until)));
    if (q.cursor) conditions.push(sql`${mailMessages.id} > ${q.cursor}`);
    // Over-fetch by one so the cursor reflects whether more rows actually
    // exist, rather than "maybe" whenever a page happens to come back full.
    const rows = await this.db
      .select()
      .from(mailMessages)
      .where(and(...conditions))
      .orderBy(mailMessages.id)
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const data = page.map((r) => toMessageRecord(r, { bodies: true }));
    const cursor = hasMore ? page[page.length - 1]!.id : null;
    return { data, cursor };
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  /**
   * One op kind's share of {@link apply}: every case whose logic is more than
   * a one-line delegation lives in its own method (named `apply<Kind>Op`) so
   * the dispatcher itself stays a plain switch, each branch a single call.
   */
  private async applyThreadLabelOp(op: Extract<MailboxOp, { kind: 'thread.label' }>, now: Date): Promise<OpResult> {
    const { affected } = await applyLabelToThread(this.db, this.ref.accountId, op.threadKey, op.label, op.action, now);
    return affected > 0
      ? { applied: [op.threadKey], missing: [], stale: [], ready: true }
      : { applied: [], missing: [op.threadKey], stale: [], ready: true };
  }

  private async applyThreadReadOp(op: Extract<MailboxOp, { kind: 'thread.read' }>, now: Date): Promise<OpResult> {
    const result = await markThreadRead(this.db, this.ref.accountId, op.threadKey, op.isRead, now);
    return { applied: result.updatedIds, missing: [], stale: [], updatedIds: result.updatedIds, ready: true };
  }

  private async applyFolderReadOp(op: Extract<MailboxOp, { kind: 'folder.read' }>, now: Date): Promise<OpResult> {
    const result = await markFolderReadForAccounts(
      this.db,
      [this.ref.accountId],
      { labelSlug: op.scope.labelSlug, search: op.scope.search, from: op.scope.from, to: op.scope.to, subject: op.scope.subject, hasAttachment: op.scope.hasAttachment, excludeWords: op.scope.excludeWords },
      { batchSize: op.batchSize, maxBatches: op.maxBatches, updatedPerAccount: op.keepIds },
      now,
    );
    return {
      applied: result.updatedIds,
      missing: [],
      stale: [],
      updatedIds: result.updatedIds,
      more: result.more,
      ready: true,
    };
  }

  private async applyThreadSetOp(op: Extract<MailboxOp, { kind: 'thread.set' }>, now: Date): Promise<OpResult> {
    const row = await updateMessage(this.db, op.id, { threadId: op.threadId }, now);
    return row
      ? { applied: [op.id], missing: [], stale: [], ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }

  private async applyLabelRenameOp(op: Extract<MailboxOp, { kind: 'label.rename' }>, now: Date): Promise<OpResult> {
    await relabelMessages(this.db, this.ref.accountId, op.from, op.to, now);
    return { applied: [], missing: [], stale: [], ready: true };
  }

  private async applyLabelDeleteOp(op: Extract<MailboxOp, { kind: 'label.delete' }>, now: Date): Promise<OpResult> {
    await stripLabelFromMessages(this.db, this.ref.accountId, op.name, now);
    return { applied: [], missing: [], stale: [], ready: true };
  }

  private async applySnoozeWakeOp(op: Extract<MailboxOp, { kind: 'snooze.wake' }>): Promise<OpResult> {
    const scope = eq(mailMessages.accountId, this.ref.accountId);
    const { ids } = await wakeDueSnoozedMessages(this.db, { now: new Date(op.now), scope });
    const next = await nextSnoozeDueAt(this.db, { scope });
    return {
      applied: ids,
      missing: [],
      stale: [],
      updatedIds: ids,
      nextSnoozeDueAt: next ? next.getTime() : null,
      ready: true,
    };
  }

  private async applyScheduledOp(op: Extract<MailboxOp, { kind: 'scheduled' }>, now: Date): Promise<OpResult> {
    const row = await applyScheduledPatch(this.db, op.id, op.patch, now);
    return row
      ? { applied: [op.id], missing: [], stale: [], message: toMessageRecord(row, { bodies: true }), ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }

  private async applyCategoriesOp(op: Extract<MailboxOp, { kind: 'categories' }>, now: Date): Promise<OpResult> {
    const update: Record<string, unknown> = { categories: op.categories, updatedAt: now };
    if (op.important !== undefined) update.isImportant = op.important;
    const [row] = await this.db
      .update(mailMessages)
      .set(update as typeof mailMessages.$inferInsert)
      .where(and(eq(mailMessages.id, op.id), isNull(mailMessages.deletedAt)))
      .returning({ id: mailMessages.id });
    return row
      ? { applied: [op.id], missing: [], stale: [], ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }

  private async applyAttachmentCreateOp(op: Extract<MailboxOp, { kind: 'attachment.create' }>, now: Date): Promise<OpResult> {
    const row = await createAttachment(this.db, op.attachment, now);
    return { applied: [row.id], missing: [], stale: [], ready: true };
  }

  private async applyAttachmentUpdateOp(op: Extract<MailboxOp, { kind: 'attachment.update' }>, now: Date): Promise<OpResult> {
    const result = await updateAttachment(this.db, op.id, op.patch, now);
    return result
      ? { applied: [op.id], missing: [], stale: [], ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }

  private async applyAttachmentDeleteOp(op: Extract<MailboxOp, { kind: 'attachment.delete' }>, now: Date): Promise<OpResult> {
    const existing = await softDeleteAttachmentRow(this.db, op.id, now);
    return existing
      ? { applied: [op.id], missing: [], stale: [], storagePaths: existing.storagePath ? [existing.storagePath] : [], ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }

  private async applyAttachmentAssociateOp(op: Extract<MailboxOp, { kind: 'attachment.associate' }>, now: Date): Promise<OpResult> {
    await associateAttachments(this.db, op.messageId, op.attachmentIds, now);
    return { applied: op.attachmentIds, missing: [], stale: [], ready: true };
  }

  private async applySubscriptionUpsertOp(op: Extract<MailboxOp, { kind: 'subscription.upsert' }>, now: Date): Promise<OpResult> {
    await reconcileSubscriptions(this.db, this.ref.accountId, op.values, now);
    return { applied: [], missing: [], stale: [], ready: true };
  }

  private async applySubscriptionStatusOp(op: Extract<MailboxOp, { kind: 'subscription.status' }>): Promise<OpResult> {
    const row = await updateSubscriptionStatus(this.db, op.id, op.patch);
    return row
      ? { applied: [op.id], missing: [], stale: [], ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }

  private async applyDraftCreateOp(op: Extract<MailboxOp, { kind: 'draft.create' }>, now: Date): Promise<OpResult> {
    const row = await createDraft(this.db, op.draft, now);
    return { applied: [row.id], missing: [], stale: [], ready: true };
  }

  private async applyDraftUpdateOp(op: Extract<MailboxOp, { kind: 'draft.update' }>, now: Date): Promise<OpResult> {
    const result = await updateDraft(this.db, op.id, op.patch, now);
    return result
      ? { applied: [op.id], missing: [], stale: [], ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }

  private async applyDraftDeleteOp(op: Extract<MailboxOp, { kind: 'draft.delete' }>, now: Date): Promise<OpResult> {
    const existing = await softDeleteDraft(this.db, op.id, now);
    return existing
      ? { applied: [op.id], missing: [], stale: [], ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }

  async apply(op: MailboxOp, at?: number): Promise<OpResult> {
    const now = at !== undefined ? new Date(at) : new Date();
    switch (op.kind) {
      case 'ingest':
        return this.applyIngest(op.message, now);
      case 'flags':
        return op.semantics === 'single'
          ? this.applySingleFlags(op.ids, op.patch, now)
          : this.applyBulkFlags(op.ids, op.patch, now);
      case 'labels.set':
        return this.applyLabelsSet(op.id, op.labels, now);
      case 'labels.add':
      case 'labels.remove':
        return op.semantics === 'single'
          ? this.applySingleLabelChange(op.kind, op.ids, op.labels, now)
          : this.applyBulkLabelChange(op.kind, op.ids, op.labels, now);
      case 'move':
        return this.applyMove(op.ids, op.location, now);
      case 'thread.label':
        return this.applyThreadLabelOp(op, now);
      case 'thread.read':
        return this.applyThreadReadOp(op, now);
      case 'folder.read':
        return this.applyFolderReadOp(op, now);
      case 'thread.set':
        return this.applyThreadSetOp(op, now);
      case 'label.rename':
        return this.applyLabelRenameOp(op, now);
      case 'label.delete':
        return this.applyLabelDeleteOp(op, now);
      case 'delete':
        return op.hard ? this.hardDeleteMessages(op.ids) : this.softDeleteMessages(op.ids, now);
      case 'snooze':
      case 'resnooze':
        return this.applySnooze(op.id, new Date(op.until), op.kind === 'resnooze', now);
      case 'unsnooze':
        return this.applyUnsnooze(op.id, now);
      case 'snooze.wake':
        return this.applySnoozeWakeOp(op);
      case 'scheduled':
        return this.applyScheduledOp(op, now);
      case 'delivery.match':
        return this.applyDeliveryMatch(op, now);
      case 'inbound.finalize':
        return this.applyInboundFinalize(op, now);
      case 'categories':
        return this.applyCategoriesOp(op, now);
      case 'attachment.create':
        return this.applyAttachmentCreateOp(op, now);
      case 'attachment.update':
        return this.applyAttachmentUpdateOp(op, now);
      case 'attachment.delete':
        return this.applyAttachmentDeleteOp(op, now);
      case 'attachment.associate':
        return this.applyAttachmentAssociateOp(op, now);
      case 'subscription.upsert':
        return this.applySubscriptionUpsertOp(op, now);
      case 'subscription.status':
        return this.applySubscriptionStatusOp(op);
      case 'draft.create':
        return this.applyDraftCreateOp(op, now);
      case 'draft.update':
        return this.applyDraftUpdateOp(op, now);
      case 'draft.delete':
        return this.applyDraftDeleteOp(op, now);
      default: {
        const _exhaustive: never = op;
        throw new Error(`Unknown mailbox op: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  async applyBatch(ops: MailboxOp[], at?: number): Promise<OpResult[]> {
    const results: OpResult[] = [];
    for (const op of ops) results.push(await this.apply(op, at));
    return results;
  }

  // ---------------------------------------------------------------------
  // apply() helpers
  // ---------------------------------------------------------------------

  private async existingIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(and(inArray(mailMessages.id, ids), isNull(mailMessages.deletedAt)));
    return new Set(rows.map((r) => r.id));
  }

  /**
   * `message.threadId`, resolved via `message.threadHints` when absent
   * (`resolveInboundThread`), falling back to the message's own id when
   * neither yields one. A hint match that turns out to be a true duplicate
   * short-circuits ingest entirely — `duplicate: true` carries the
   * already-built {@link OpResult} for {@link applyIngest} to return as-is.
   */
  private async resolveIngestThreadId(
    message: IngestMessage,
  ): Promise<{ duplicate: true; result: OpResult } | { duplicate: false; threadId: string }> {
    let threadId = message.threadId;
    if (!threadId && message.threadHints) {
      const resolved = await resolveInboundThread(this.db, this.ref.accountId, message.threadHints);
      if (resolved.duplicate) {
        const ingest: IngestResult = {
          id: message.id,
          threadKey: resolved.threadId,
          created: false,
          duplicateOf: resolved.threadId,
        };
        return { duplicate: true, result: { applied: [], missing: [], stale: [], ingest, ready: true } };
      }
      threadId = resolved.threadId;
    }
    return { duplicate: false, threadId: threadId ?? message.id };
  }

  /** The `mail_messages` row values for a fresh ingest insert. */
  private buildIngestValues(message: IngestMessage, threadId: string, now: Date) {
    const labels = message.labels;
    return {
      id: message.id,
      accountId: this.ref.accountId,
      messageId: message.rfcMessageId,
      threadId,
      externalMessageId: message.externalMessageId ?? undefined,
      providerMessageId: message.providerMessageId ?? undefined,
      from: message.from,
      to: message.to,
      cc: message.cc ?? undefined,
      bcc: message.bcc ?? undefined,
      replyTo: message.replyTo ?? undefined,
      subject: message.subject ?? undefined,
      preview: message.preview ?? undefined,
      textBody: message.content?.text ?? undefined,
      htmlBody: message.content?.html ?? undefined,
      sentDate: new Date(message.sentAt),
      receivedDate: message.receivedAt != null ? new Date(message.receivedAt) : undefined,
      isRead: message.isRead,
      labels,
      isSpam: message.isSpam,
      isStarred: labels.includes(SYSTEM_LABELS.STARRED),
      isImportant: labels.includes(SYSTEM_LABELS.IMPORTANT),
      isTrash: labels.includes(SYSTEM_LABELS.TRASH),
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.references ?? undefined,
      isReply: message.isReply,
      isForwarded: message.isForwarded ?? undefined,
      priority: toPriorityValue(message.priority),
      sizeBytes: message.sizeBytes ?? undefined,
      spfStatus: toSecurityStatusValue(message.spfStatus),
      dkimStatus: toSecurityStatusValue(message.dkimStatus),
      dmarcStatus: toSecurityStatusValue(message.dmarcStatus),
      sendStatus: message.sendStatus ?? undefined,
      scheduledFor: message.scheduledFor != null ? new Date(message.scheduledFor) : undefined,
      triggerRunId: message.triggerRunId ?? undefined,
      idempotencyKey: message.idempotencyKey ?? undefined,
      deliveryStatus: message.delivery?.status ?? undefined,
      deliveryDetail: message.delivery?.detail ?? undefined,
      deliveryUpdatedAt: message.delivery ? new Date(message.delivery.at) : undefined,
      source: message.source === 'scheduled' ? 'sent' : message.source,
      hasAttachments: message.attachments.length > 0,
      attachmentCount: message.attachments.length,
      headers: message.extra?.headers ?? undefined,
      customFields: message.extra?.customFields ?? undefined,
      clickedLinks: message.extra?.clickedLinks ?? undefined,
      conversationId: message.extra?.conversationId ?? undefined,
      createdAt: new Date(message.createdAt),
      updatedAt: now,
    };
  }

  /** Lost a concurrent insert of the same id: the id exists now, so report it as the (not-created-by-us) ingest result. */
  private async recoverConflictedIngest(message: IngestMessage): Promise<OpResult> {
    const [existing] = await this.db
      .select({ id: mailMessages.id, threadId: mailMessages.threadId })
      .from(mailMessages)
      .where(eq(mailMessages.id, message.id))
      .limit(1);
    const ingest: IngestResult = { id: message.id, threadKey: existing?.threadId ?? message.id, created: false };
    return { applied: [], missing: [], stale: [], ingest, ready: true };
  }

  /** Attachment rows and the subscription upsert that ride alongside a successful ingest insert. */
  private async finishIngestSideEffects(message: IngestMessage, now: Date): Promise<void> {
    if (message.attachments.length > 0) {
      await this.db.insert(mailAttachments).values(
        message.attachments.map((a) => ({
          id: a.id,
          messageId: message.id,
          fileName: a.fileName,
          contentType: a.contentType,
          size: a.size,
          storagePath: a.storagePath,
          downloadUrl: a.downloadUrl,
          checksum: a.checksum,
          isInline: a.isInline ?? false,
          contentId: a.contentId,
          contentDisposition: a.contentDisposition,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    if (message.subscription) {
      await upsertSubscriptionOnMessage(this.db, this.ref.accountId, message.subscription, now);
    }
  }

  private async applyIngest(message: IngestMessage, now: Date): Promise<OpResult> {
    const [byId] = await this.db
      .select({ id: mailMessages.id, threadId: mailMessages.threadId })
      .from(mailMessages)
      .where(eq(mailMessages.id, message.id))
      .limit(1);
    if (byId) {
      const ingest: IngestResult = { id: byId.id, threadKey: byId.threadId ?? byId.id, created: false };
      return { applied: [], missing: [], stale: [], ingest, ready: true };
    }

    const threadResolution = await this.resolveIngestThreadId(message);
    if (threadResolution.duplicate) return threadResolution.result;

    const inserted = await this.db
      .insert(mailMessages)
      .values(this.buildIngestValues(message, threadResolution.threadId, now))
      .onConflictDoNothing({ target: mailMessages.id })
      .returning({ id: mailMessages.id, threadId: mailMessages.threadId });

    if (inserted.length === 0) return this.recoverConflictedIngest(message);

    await this.finishIngestSideEffects(message, now);

    const ingest: IngestResult = { id: message.id, threadKey: inserted[0]!.threadId ?? inserted[0]!.id, created: true };
    return { applied: [message.id], missing: [], stale: [], ingest, ready: true };
  }

  private async applySingleFlags(ids: string[], patch: FlagPatch, now: Date): Promise<OpResult> {
    const applied: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const row = await updateMessage(this.db, id, { ...patch }, now);
      if (row) applied.push(id);
      else missing.push(id);
    }
    return { applied, missing, stale: [], ready: true };
  }

  /** Adds or removes `label` on every id in `idsArr`, in bulk. */
  private async applyBulkLabelToggle(label: string, on: boolean, idsArr: string[], now: Date): Promise<void> {
    if (on) await bulkAddLabelToMessages(this.db, label, idsArr, now);
    else await bulkRemoveLabelFromMessages(this.db, label, idsArr, now);
  }

  /** {@link applyBulkFlags}'s per-field writes, once there is at least one existing id to apply them to. */
  private async applyBulkFlagFields(idsArr: string[], patch: FlagPatch, now: Date): Promise<void> {
    if (patch.isRead !== undefined) {
      await this.db.update(mailMessages).set({ isRead: patch.isRead, updatedAt: now }).where(inArray(mailMessages.id, idsArr));
    }
    if (patch.isFlagged !== undefined) {
      await this.db
        .update(mailMessages)
        .set({ isFlagged: patch.isFlagged, updatedAt: now })
        .where(inArray(mailMessages.id, idsArr));
    }
    if (patch.isStarred !== undefined) {
      await this.applyBulkLabelToggle(SYSTEM_LABELS.STARRED, patch.isStarred, idsArr, now);
    }
    if (patch.isImportant !== undefined) {
      await this.applyBulkLabelToggle(SYSTEM_LABELS.IMPORTANT, patch.isImportant, idsArr, now);
    }
    // isSpam before isTrash, same precedence `labelsForFlagPatch` uses when
    // a caller somehow sets both.
    if (patch.isSpam !== undefined) {
      await moveMessagesToLocation(this.db, idsArr, patch.isSpam ? SYSTEM_LABELS.SPAM : SYSTEM_LABELS.INBOX, now);
    }
    if (patch.isTrash !== undefined) {
      await moveMessagesToLocation(this.db, idsArr, patch.isTrash ? SYSTEM_LABELS.TRASH : SYSTEM_LABELS.INBOX, now);
    }
  }

  private async applyBulkFlags(ids: string[], patch: FlagPatch, now: Date): Promise<OpResult> {
    const existing = await this.existingIds(ids);
    const idsArr = [...existing];
    if (idsArr.length > 0) await this.applyBulkFlagFields(idsArr, patch, now);
    return { applied: idsArr, missing: ids.filter((id) => !existing.has(id)), stale: [], ready: true };
  }

  private async applyLabelsSet(id: string, labels: string[], now: Date): Promise<OpResult> {
    const [existing] = await this.db
      .select({ accountId: mailMessages.accountId })
      .from(mailMessages)
      .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
      .limit(1);
    if (!existing) return { applied: [], missing: [id], stale: [], ready: true };
    const canonical = await canonicalLabelNames(this.db, existing.accountId, labels);
    const next = [...new Set(canonical.map(normalizeLabel))];
    await this.db
      .update(mailMessages)
      .set({
        labels: next,
        isStarred: next.includes(SYSTEM_LABELS.STARRED),
        isImportant: next.includes(SYSTEM_LABELS.IMPORTANT),
        isTrash: next.includes(SYSTEM_LABELS.TRASH),
        isSpam: next.includes(SYSTEM_LABELS.SPAM),
        updatedAt: now,
      })
      .where(eq(mailMessages.id, id));
    return { applied: [id], missing: [], stale: [], labels: { [id]: next }, ready: true };
  }

  private async applySingleLabelChange(
    kind: 'labels.add' | 'labels.remove',
    ids: string[],
    labels: string[],
    now: Date,
  ): Promise<OpResult> {
    const applied: string[] = [];
    const missing: string[] = [];
    const resultLabels: Record<string, string[]> = {};
    for (const id of ids) {
      const next =
        kind === 'labels.add'
          ? await addMessageLabels(this.db, id, labels, now)
          : await removeMessageLabels(this.db, id, labels, now);
      if (next) {
        applied.push(id);
        resultLabels[id] = next;
      } else {
        missing.push(id);
      }
    }
    return { applied, missing, stale: [], labels: resultLabels, ready: true };
  }

  private async applyBulkLabelChange(
    kind: 'labels.add' | 'labels.remove',
    ids: string[],
    labels: string[],
    now: Date,
  ): Promise<OpResult> {
    const existing = await this.existingIds(ids);
    const idsArr = [...existing];
    if (idsArr.length > 0) {
      for (const label of labels) {
        if (kind === 'labels.add') await bulkAddLabelToMessages(this.db, label, idsArr, now);
        else await bulkRemoveLabelFromMessages(this.db, label, idsArr, now);
      }
    }
    // `applySingleLabelChange` fills `labels` per applied id (it already reads
    // each row back); the bulk path didn't, leaving the object as the only
    // backend that returned labels at all for `semantics: 'bulk'` — read the
    // final `labels` column back for the same ids so both semantics agree.
    const resultLabels = await this.finalLabelsFor(idsArr);
    return { applied: idsArr, missing: ids.filter((id) => !existing.has(id)), stale: [], labels: resultLabels, ready: true };
  }

  /** The current `labels` array for each of `ids`, keyed by id — used to fill `OpResult.labels` after a bulk write that doesn't already return the final row. */
  private async finalLabelsFor(ids: string[]): Promise<Record<string, string[]>> {
    if (ids.length === 0) return {};
    const rows = await this.db.select({ id: mailMessages.id, labels: mailMessages.labels }).from(mailMessages).where(inArray(mailMessages.id, ids));
    const out: Record<string, string[]> = {};
    for (const row of rows) out[row.id] = row.labels ?? [];
    return out;
  }

  private async applyMove(ids: string[], location: LocationLabel, now: Date): Promise<OpResult> {
    const existing = await this.existingIds(ids);
    const idsArr = [...existing];
    if (idsArr.length > 0) await moveMessagesToLocation(this.db, idsArr, location, now);
    return { applied: idsArr, missing: ids.filter((id) => !existing.has(id)), stale: [], ready: true };
  }

  private async softDeleteMessages(ids: string[], now: Date): Promise<OpResult> {
    const applied: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const result = await softDeleteMessage(this.db, id, now);
      if (result) applied.push(id);
      else missing.push(id);
    }
    return { applied, missing, stale: [], ready: true };
  }

  private async hardDeleteMessages(ids: string[]): Promise<OpResult> {
    if (ids.length === 0) return { applied: [], missing: [], stale: [], ready: true };
    const attachmentRows = await this.db
      .select({ storagePath: mailAttachments.storagePath })
      .from(mailAttachments)
      .where(inArray(mailAttachments.messageId, ids));
    const storagePaths = attachmentRows.map((a) => a.storagePath).filter((p): p is string => !!p);
    await this.db.delete(mailAttachments).where(inArray(mailAttachments.messageId, ids));
    const deleted = await this.db
      .delete(mailMessages)
      .where(and(inArray(mailMessages.id, ids), eq(mailMessages.accountId, this.ref.accountId)))
      .returning({ id: mailMessages.id });
    const appliedSet = new Set(deleted.map((d) => d.id));
    return {
      applied: [...appliedSet],
      missing: ids.filter((id) => !appliedSet.has(id)),
      stale: [],
      storagePaths,
      ready: true,
    };
  }

  private async applySnooze(id: string, until: Date, isResnooze: boolean, now: Date): Promise<OpResult> {
    try {
      if (isResnooze) await resnoozeMessage(this.db, this.ref.accountId, id, until, now);
      else await snoozeMessage(this.db, this.ref.accountId, id, until, now);
      return { applied: [id], missing: [], stale: [], ready: true };
    } catch (err) {
      if (err instanceof MailSnoozeError && err.code === 'MESSAGE_NOT_FOUND') {
        return { applied: [], missing: [id], stale: [], ready: true };
      }
      throw err;
    }
  }

  private async applyUnsnooze(id: string, now: Date): Promise<OpResult> {
    try {
      await unsnoozeMessage(this.db, this.ref.accountId, id, now);
      return { applied: [id], missing: [], stale: [], ready: true };
    } catch (err) {
      if (err instanceof MailSnoozeError && err.code === 'MESSAGE_NOT_FOUND') {
        return { applied: [], missing: [id], stale: [], ready: true };
      }
      throw err;
    }
  }

  private async applyDeliveryMatch(
    op: Extract<MailboxOp, { kind: 'delivery.match' }>,
    now: Date,
  ): Promise<OpResult> {
    const recipient = op.recipient.trim().toLowerCase();
    const eventAt = new Date(op.eventAt);
    const recipientMatch = sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        COALESCE(CASE WHEN jsonb_typeof(${mailMessages.to}) = 'array' THEN ${mailMessages.to} END, '[]'::jsonb)
        || COALESCE(CASE WHEN jsonb_typeof(${mailMessages.cc}) = 'array' THEN ${mailMessages.cc} END, '[]'::jsonb)
        || COALESCE(CASE WHEN jsonb_typeof(${mailMessages.bcc}) = 'array' THEN ${mailMessages.bcc} END, '[]'::jsonb)
      ) AS r WHERE lower(r->>'email') = ${recipient}
    )`;
    const [row] = await this.db
      .select({ id: mailMessages.id, deliveryStatus: mailMessages.deliveryStatus })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.accountId, this.ref.accountId),
          eq(mailMessages.source, 'sent'),
          gte(mailMessages.sentDate, new Date(eventAt.getTime() - 3 * 86_400_000)),
          lte(mailMessages.sentDate, new Date(eventAt.getTime() + 3_600_000)),
          recipientMatch,
        ),
      )
      .orderBy(desc(mailMessages.sentDate))
      .limit(1);
    if (!row) return { applied: [], missing: [], stale: [], ready: true };
    if (row.deliveryStatus && DELIVERY_STATUS_RANK[row.deliveryStatus] > DELIVERY_STATUS_RANK[op.status]) {
      return { applied: [], missing: [], stale: [row.id], ready: true };
    }
    await this.db
      .update(mailMessages)
      .set({ deliveryStatus: op.status, deliveryUpdatedAt: now, deliveryDetail: op.detail })
      .where(eq(mailMessages.id, row.id));
    return { applied: [row.id], missing: [], stale: [], ready: true };
  }

  private async applyInboundFinalize(
    op: Extract<MailboxOp, { kind: 'inbound.finalize' }>,
    now: Date,
  ): Promise<OpResult> {
    const update: Record<string, unknown> = {
      labels: op.labels,
      isRead: op.isRead,
      isFlagged: op.isFlagged,
      isSpam: op.isSpam,
      isTrash: op.labels.includes(SYSTEM_LABELS.TRASH),
      updatedAt: now,
    };
    if (op.deleted) update.deletedAt = now;
    const [row] = await this.db
      .update(mailMessages)
      .set(update as typeof mailMessages.$inferInsert)
      .where(and(eq(mailMessages.id, op.id), eq(mailMessages.accountId, this.ref.accountId)))
      .returning({ id: mailMessages.id });
    return row
      ? { applied: [op.id], missing: [], stale: [], ready: true }
      : { applied: [], missing: [op.id], stale: [], ready: true };
  }
}
