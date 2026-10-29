/**
 * `ObjectWorkspaceMailStore`: the mailbox object's implementation of
 * `WorkspaceMailStore` (design task C2, §2.1/§5) — every cross-mailbox read
 * answered by fanning out to each accessible mailbox's `ObjectMailboxStore`
 * in parallel (bounded, `./concurrency`) and merging with the shared
 * comparators (`../merge`), the same way `PostgresWorkspaceMailStore`
 * (`../postgres/workspace-store.ts`) answers them with one SQL query over
 * `accountIds` — this is the object backend's equivalent fan-in.
 *
 * Every method already receives its caller's accessible `accountIds`
 * (resolved by `MailAccess`, design §6) — this class does no access
 * resolution of its own, same division of labour as the Postgres store.
 *
 * **Partial-mailbox-failure policy** (design task brief: "one mailbox
 * failing must not fail the whole list"): every fan-out goes through
 * `./fanout`'s `fanOutToMailboxes`, which tolerates individual mailbox
 * failures and aggregates whichever ones answered; seen in full in that
 * file's header comment. In short: no `partial`/`failedAccountIds` marker on
 * the return value (none of `WorkspaceMailStore`'s shared return shapes has
 * room for one without widening them for this one caller), a failed mailbox
 * is logged and dropped from the merged result, and the call only throws
 * when EVERY mailbox in the fan-out failed.
 */

import type { MailDraft } from '@weldsuite/db/schema/mail-drafts';
import { mailIndexFor, type MailIndexBindingEnv } from '../../mail-index/client';
import type { MessageStats } from '../../messages';
import type { ThreadSummary } from '../../threads';
import { byOrderKey, compareMessageOrder, compareThreadOrder, mergeSortedPages, type MergeSource } from '../merge';
import { ObjectMailboxStore, type ObjectMailboxStoreEnv } from './mailbox-store';
import { fanOutToMailboxes } from './fanout';
import type {
  MailAttachmentRecord,
  MailboxStore,
  MailMessageListRow,
  MailMessageRecord,
  MarkFolderReadOptions,
  MessageCursor,
  MessageListQuery,
  MessagePage,
  MailStoreMode,
  SnoozedMessage,
  ThreadCursor,
  ThreadFilter,
  ThreadListQuery,
  ThreadPage,
  WorkspaceMailStore,
} from '../types';

export interface ObjectWorkspaceMailStoreEnv extends ObjectMailboxStoreEnv, MailIndexBindingEnv {}

/** How many mailboxes are read in parallel for one unified-inbox call. A workspace can have dozens of mailboxes; this keeps one page load from opening that many Workers subrequests simultaneously. */
const FANOUT_CONCURRENCY = 8;

/** Design §5: "offset mode fetches `offset + pageSize` from each mailbox (capped at 5000)." */
const MAX_THREAD_OFFSET = 5000;

/** Design §5: "`recentAttachments(accountIds, {limit: 2000 per mailbox})`." */
const RECENT_ATTACHMENTS_PER_MAILBOX_CAP = 2000;

/** Design §5: "`markFolderRead` across mailboxes re-issues per mailbox while `more` is true (bounded)." */
const MAX_FOLDER_READ_REISSUES = 20;

const EMPTY_MESSAGE_STATS: MessageStats = {
  total: 0,
  unread: 0,
  inboxUnread: 0,
  starred: 0,
  importantUnread: 0,
  sentUnread: 0,
  archiveUnread: 0,
  trashUnread: 0,
  spam: 0,
  snoozed: 0,
  scheduled: 0,
  drafts: 0,
};
const MESSAGE_STATS_KEYS = Object.keys(EMPTY_MESSAGE_STATS) as (keyof MessageStats)[];

function threadOrderKey(t: ThreadSummary): { latestAt: number; accountId: string; threadKey: string } {
  return { latestAt: (t.latestDate ?? new Date(0)).getTime(), accountId: t.accountId, threadKey: t.threadId };
}

function messageOrderKey(m: MailMessageListRow): { sentAt: number; id: string } {
  return { sentAt: (m.sentDate ?? new Date(0)).getTime(), id: m.id };
}

/** `createdAt DESC, id DESC` — matches `PostgresWorkspaceMailStore.recentAttachments`'s `orderBy` and the object's own `recentAttachments` SQL (design §3.1's `attachments_recent_idx`). */
function compareAttachmentRecent(a: MailAttachmentRecord, b: MailAttachmentRecord): number {
  const at = a.createdAt?.getTime() ?? 0;
  const bt = b.createdAt?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

/** `updatedAt DESC, id DESC` — matches the object's `drafts_updated_idx`. */
function compareDraftRecent(a: MailDraft, b: MailDraft): number {
  const at = a.updatedAt?.getTime() ?? 0;
  const bt = b.updatedAt?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

/** Every `succeeded` fan-out mailbox's rows folded into `into`, first mailbox to claim an id wins (matches the plain for-loop this replaces: later duplicates are skipped, not overwritten). */
function mergeLocatedMessages(
  succeeded: ReadonlyArray<{ value: { accountId: string; rows: ReadonlyArray<{ id: string }> } }>,
  into: Map<string, string>,
): void {
  for (const { value } of succeeded) {
    for (const row of value.rows) if (!into.has(row.id)) into.set(row.id, value.accountId);
  }
}

export class ObjectWorkspaceMailStore implements WorkspaceMailStore {
  constructor(
    private readonly env: ObjectWorkspaceMailStoreEnv,
    readonly workspaceId: string,
    readonly clerkOrgId: string,
    readonly mode: MailStoreMode = 'object',
  ) {}

  mailbox(accountId: string): MailboxStore {
    return new ObjectMailboxStore(this.env, { workspaceId: this.workspaceId, accountId, clerkOrgId: this.clerkOrgId });
  }

  // -------------------------------------------------------------------
  // Unified thread/message lists
  // -------------------------------------------------------------------

  async listThreads(accountIds: string[], q: ThreadListQuery): Promise<ThreadPage> {
    if (accountIds.length === 0) return { threads: [], totalCount: 0, nextCursor: null };

    const usingOffset = q.offset !== undefined;
    const offset = usingOffset ? Math.min(Math.max(0, Math.trunc(q.offset as number)), MAX_THREAD_OFFSET) : 0;
    const mergeLimit = offset + q.pageSize;
    // Offset mode: every mailbox is asked from the top (no per-mailbox
    // offset — see this file's header comment on why that would be wrong),
    // over-fetching so the GLOBAL top `offset+pageSize` can be computed after
    // merging. Cursor mode: the same value-based cursor goes to every
    // mailbox unchanged (design §5's composite cursor is exact per mailbox).
    const perMailboxQuery: ThreadListQuery = usingOffset
      ? { ...q, offset: undefined, cursor: null, pageSize: mergeLimit }
      : { ...q, pageSize: q.pageSize };

    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) =>
      this.mailbox(accountId).listThreads(perMailboxQuery),
    );

    const totalCount = succeeded.reduce((sum, { value }) => sum + value.totalCount, 0);
    const sources: MergeSource<ThreadSummary>[] = succeeded.map(({ value }) => ({
      items: value.threads,
      hasMore: value.nextCursor !== null,
    }));
    const merged = mergeSortedPages(sources, byOrderKey(compareThreadOrder, threadOrderKey), mergeLimit);

    const page = usingOffset ? merged.items.slice(offset) : merged.items;
    const last = page.at(-1);
    const nextCursor: ThreadCursor | null = merged.hasMore && last ? threadOrderKey(last) : null;

    return { threads: page, totalCount, nextCursor };
  }

  async listMessages(accountIds: string[], q: MessageListQuery): Promise<MessagePage> {
    if (accountIds.length === 0) return { data: [], totalCount: 0, nextCursor: null };

    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) =>
      this.mailbox(accountId).listMessages(q),
    );

    const totalCount = succeeded.reduce((sum, { value }) => sum + value.totalCount, 0);
    const sources: MergeSource<MailMessageListRow>[] = succeeded.map(({ value }) => ({
      items: value.data,
      hasMore: value.nextCursor !== null,
    }));
    const merged = mergeSortedPages(sources, byOrderKey(compareMessageOrder, messageOrderKey), q.limit);
    const last = merged.items.at(-1);
    const nextCursor: MessageCursor | null = merged.hasMore && last ? messageOrderKey(last) : null;

    return { data: merged.items, totalCount, nextCursor };
  }

  // -------------------------------------------------------------------
  // Stats, unread badge
  // -------------------------------------------------------------------

  async stats(accountIds: string[]): Promise<MessageStats> {
    if (accountIds.length === 0) return { ...EMPTY_MESSAGE_STATS };
    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) => this.mailbox(accountId).stats());
    const summed = { ...EMPTY_MESSAGE_STATS };
    for (const { value } of succeeded) {
      for (const key of MESSAGE_STATS_KEYS) summed[key] += value[key];
    }
    return summed;
  }

  async unreadBadge(accountIds: string[]): Promise<number> {
    if (accountIds.length === 0) return 0;
    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) =>
      this.mailbox(accountId).unreadCount('all-live'),
    );
    return succeeded.reduce((sum, { value }) => sum + value, 0);
  }

  // -------------------------------------------------------------------
  // Locate
  // -------------------------------------------------------------------

  /** The hint mailbox's own share of `locateMessages`: resolves what it can into `result`, falls back silently to fan-out on failure. Returns the still-unresolved ids. */
  private async locateMessagesViaHint(hint: string, ids: readonly string[], result: Map<string, string>): Promise<string[]> {
    try {
      const rows = await this.mailbox(hint).getMessages([...ids]);
      for (const row of rows) result.set(row.id, hint);
    } catch (err) {
      console.error(`[mail-store/object] locateMessages: hint mailbox ${hint} failed, falling back to fan-out:`, err);
    }
    return ids.filter((id) => !result.has(id));
  }

  async locateMessages(ids: string[], accountIds: string[], hint?: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (ids.length === 0 || accountIds.length === 0) return result;

    let remaining = ids;
    const hasHint = !!hint && accountIds.includes(hint);
    if (hasHint) {
      remaining = await this.locateMessagesViaHint(hint as string, remaining, result);
      if (remaining.length === 0) return result;
    }

    const rest = hasHint ? accountIds.filter((a) => a !== hint) : accountIds;
    if (rest.length === 0) return result;
    const { succeeded } = await fanOutToMailboxes(rest, FANOUT_CONCURRENCY, async (accountId) => ({
      accountId,
      rows: await this.mailbox(accountId).getMessages(remaining),
    }));
    mergeLocatedMessages(succeeded, result);
    return result;
  }

  async locateAttachment(
    id: string,
    accountIds: string[],
    hint?: string,
  ): Promise<{ accountId: string; attachment: MailAttachmentRecord } | null> {
    if (accountIds.length === 0) return null;
    const hasHint = !!hint && accountIds.includes(hint);
    if (hasHint) {
      try {
        const attachment = await this.mailbox(hint as string).getAttachment(id);
        if (attachment) return { accountId: hint as string, attachment };
      } catch (err) {
        console.error(`[mail-store/object] locateAttachment: hint mailbox ${hint} failed, falling back to fan-out:`, err);
      }
    }
    const rest = hasHint ? accountIds.filter((a) => a !== hint) : accountIds;
    if (rest.length === 0) return null;
    const { succeeded } = await fanOutToMailboxes(rest, FANOUT_CONCURRENCY, async (accountId) => ({
      accountId,
      attachment: await this.mailbox(accountId).getAttachment(id),
    }));
    const found = succeeded.find(({ value }) => value.attachment);
    return found ? { accountId: found.value.accountId, attachment: found.value.attachment! } : null;
  }

  async locateDraft(id: string, accountIds: string[], hint?: string): Promise<{ accountId: string; draft: MailDraft } | null> {
    if (accountIds.length === 0) return null;
    const hasHint = !!hint && accountIds.includes(hint);
    if (hasHint) {
      try {
        const draft = await this.mailbox(hint as string).getDraft(id);
        if (draft) return { accountId: hint as string, draft };
      } catch (err) {
        console.error(`[mail-store/object] locateDraft: hint mailbox ${hint} failed, falling back to fan-out:`, err);
      }
    }
    const rest = hasHint ? accountIds.filter((a) => a !== hint) : accountIds;
    if (rest.length === 0) return null;
    const { succeeded } = await fanOutToMailboxes(rest, FANOUT_CONCURRENCY, async (accountId) => ({
      accountId,
      draft: await this.mailbox(accountId).getDraft(id),
    }));
    const found = succeeded.find(({ value }) => value.draft);
    return found ? { accountId: found.value.accountId, draft: found.value.draft! } : null;
  }

  // -------------------------------------------------------------------
  // Counterparty (CRM Emails tab)
  // -------------------------------------------------------------------

  async messagesByCounterparty(
    address: string,
    accountIds: string[],
    q: { cursor?: MessageCursor; limit: number },
  ): Promise<MessagePage> {
    if (accountIds.length === 0) return { data: [], totalCount: 0, nextCursor: null };
    const candidates = await this.candidateMailboxesForAddress(address, accountIds);
    return this.listMessages(candidates, { limit: q.limit, cursor: q.cursor, counterparty: address });
  }

  /**
   * Design §5: "If the ledger's address index is seeded, take
   * `mailboxesForAddress(address)` ∩ accessible accounts; otherwise all
   * accessible accounts." "Seeded" is checked explicitly (`MailIndex.status`)
   * rather than treating an empty `mailboxesForAddress` result as
   * "unavailable": once the index is seeded, an empty result is authoritative
   * ("this address has no known mailbox"), not a reason to fall back to a
   * full, wasteful fan-out — `listMessages` still filters by `counterparty`
   * either way, so a wrong fallback decision here costs performance, not
   * correctness.
   */
  private async candidateMailboxesForAddress(address: string, accountIds: string[]): Promise<string[]> {
    const index = mailIndexFor(this.env, this.workspaceId);
    if (!index) return accountIds;
    try {
      const [status, mailboxes] = await Promise.all([
        index.status(this.workspaceId),
        index.mailboxesForAddress(this.workspaceId, address),
      ]);
      if (!status.seeded) return accountIds;
      const accessible = new Set(accountIds);
      return mailboxes.filter((accountId) => accessible.has(accountId));
    } catch (err) {
      console.error('[mail-store/object] MailIndex lookup failed, falling back to every accessible mailbox:', err);
      return accountIds;
    }
  }

  // -------------------------------------------------------------------
  // Drive
  // -------------------------------------------------------------------

  async recentAttachments(
    accountIds: string[],
    q: { limit: number },
  ): Promise<{ data: Array<MailAttachmentRecord & { accountId: string }>; totalCount: number }> {
    if (accountIds.length === 0) return { data: [], totalCount: 0 };
    const perMailboxLimit = Math.min(Math.max(q.limit, 1), RECENT_ATTACHMENTS_PER_MAILBOX_CAP);
    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, async (accountId) => {
      const page = await this.mailbox(accountId).recentAttachments({ limit: perMailboxLimit });
      return { totalCount: page.totalCount, items: page.data.map((a) => ({ ...a, accountId })) };
    });
    const totalCount = succeeded.reduce((sum, { value }) => sum + value.totalCount, 0);
    const sources = succeeded.map(({ value }) => ({ items: value.items, hasMore: value.items.length >= perMailboxLimit }));
    const merged = mergeSortedPages(sources, compareAttachmentRecent, q.limit);
    return { data: merged.items, totalCount };
  }

  // -------------------------------------------------------------------
  // AI context
  // -------------------------------------------------------------------

  async recentMessages(accountIds: string[], limit: number): Promise<MailMessageListRow[]> {
    if (accountIds.length === 0) return [];
    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) =>
      this.mailbox(accountId).listMessages({ limit }),
    );
    const sources: MergeSource<MailMessageListRow>[] = succeeded.map(({ value }) => ({
      items: value.data,
      hasMore: value.nextCursor !== null,
    }));
    const merged = mergeSortedPages(sources, byOrderKey(compareMessageOrder, messageOrderKey), limit);
    return merged.items;
  }

  // -------------------------------------------------------------------
  // Mark folder read
  // -------------------------------------------------------------------

  async markFolderRead(
    accountIds: string[],
    scope: ThreadFilter,
    o?: MarkFolderReadOptions,
  ): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[] }> {
    if (accountIds.length === 0) return { updatedCount: 0, updated: [] };
    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) =>
      this.markFolderReadOneMailbox(accountId, scope, o),
    );
    const updated = succeeded.flatMap(({ value }) => value);
    return { updatedCount: updated.length, updated };
  }

  /** Re-issues `folder.read` on one mailbox while `OpResult.more` is true, bounded (design §5). */
  private async markFolderReadOneMailbox(
    accountId: string,
    scope: ThreadFilter,
    o?: MarkFolderReadOptions,
  ): Promise<{ id: string; accountId: string }[]> {
    const mailbox = this.mailbox(accountId);
    const updated: { id: string; accountId: string }[] = [];
    for (let reissue = 0; reissue < MAX_FOLDER_READ_REISSUES; reissue++) {
      const result = await mailbox.apply({
        kind: 'folder.read',
        scope,
        batchSize: o?.batchSize,
        maxBatches: o?.maxBatches,
        keepIds: o?.updatedPerAccount,
      });
      for (const id of result.updatedIds ?? []) updated.push({ id, accountId });
      if (!result.more) break;
    }
    return updated;
  }

  // -------------------------------------------------------------------
  // Snoozed / scheduled / drafts
  // -------------------------------------------------------------------

  async listSnoozed(accountIds: string[]): Promise<SnoozedMessage[]> {
    if (accountIds.length === 0) return [];
    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) => this.mailbox(accountId).listSnoozed());
    return succeeded.flatMap(({ value }) => value);
  }

  async listScheduled(accountIds: string[]): Promise<MailMessageRecord[]> {
    if (accountIds.length === 0) return [];
    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) => this.mailbox(accountId).listScheduled());
    return succeeded.flatMap(({ value }) => value);
  }

  /**
   * Cross-mailbox draft paging has no designed composite cursor (design §5's
   * "Reads that span mailboxes" covers threads/messages/stats/badge/
   * counterparty/drive/locate, not drafts). This answers the first page
   * correctly — every accessible mailbox's most-recently-updated drafts,
   * merged — but `q.cursor` is accepted and ignored: there is no per-mailbox
   * cursor here that composes into a correct global second page. Good enough
   * for a "recent drafts" aggregate view, same scope as `recentAttachments`/
   * `recentMessages`; flagged here for whichever consumer task needs true
   * deep pagination of this particular list.
   */
  async listDrafts(
    accountIds: string[],
    q: { limit: number; cursor?: string },
  ): Promise<{ data: MailDraft[]; hasMore: boolean; cursor: string | null; totalCount: number }> {
    if (accountIds.length === 0) return { data: [], hasMore: false, cursor: null, totalCount: 0 };
    const { succeeded } = await fanOutToMailboxes(accountIds, FANOUT_CONCURRENCY, (accountId) =>
      this.mailbox(accountId).listDrafts({ limit: q.limit }),
    );
    const totalCount = succeeded.reduce((sum, { value }) => sum + value.totalCount, 0);
    const merged = succeeded
      .flatMap(({ value }) => value.data)
      .sort(compareDraftRecent)
      .slice(0, q.limit);
    return { data: merged, hasMore: totalCount > merged.length, cursor: null, totalCount };
  }
}
