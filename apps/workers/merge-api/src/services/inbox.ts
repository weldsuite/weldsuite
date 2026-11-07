/**
 * The inbox: computed per request. Read, snooze and archive state is per member
 * in `merge_inbox_states`, keyed by the item's id (`<kind>:<subject id>`) and
 * applied to the derived items: an archived or still-snoozed item is left out
 * unless asked for (`?include=archived|snoozed`).
 */

import { and, desc, eq, gte, inArray, isNull, type SQL } from 'drizzle-orm';
import type { MergeInboxItem } from '@weldsuite/app-api-client/schemas/weldmerge';
import type {
  MergeInboxInclude,
  MergeInboxItemStateDto,
  UpdateMergeInboxItemInput,
} from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import { generateId } from '@weldsuite/worker-kit/id';
import { iso, mergeInboxStates, mergeIssues, mergePullRequests, type Db } from './db';
import { hydrateIssues } from './issues';
import {
  authoredBy,
  memberGithubLogin,
  queryPullRequests,
  reviewRequestedFrom,
  toListItems,
} from './pull-requests';

const PER_KIND = 50;
const ASSIGNED_DAYS = 14;
const MERGED_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InboxOptions {
  userId: string;
  /** The member may read issues: the "assigned" items are left out otherwise. */
  canReadIssues: boolean;
  /** Also return the archived or the still-snoozed items. */
  include?: MergeInboxInclude;
  now?: Date;
}

/** Descending by time, then by id. */
function newestFirst(a: MergeInboxItem, b: MergeInboxItem): number {
  const [left, right] = a.at === b.at ? [a.id, b.id] : [a.at, b.at];
  return left < right ? 1 : -1;
}

/**
 * Applies the member's read, snooze and archive state to derived items. A
 * snooze that has passed is over (`snoozedUntil` null again).
 */
async function applyStates(
  db: Db,
  userId: string,
  items: MergeInboxItem[],
  include: MergeInboxInclude | undefined,
  now: Date,
): Promise<MergeInboxItem[]> {
  if (items.length === 0) return items;
  const states = await db
    .select()
    .from(mergeInboxStates)
    .where(
      and(
        eq(mergeInboxStates.userId, userId),
        inArray(
          mergeInboxStates.itemKey,
          items.map((i) => i.id),
        ),
      ),
    );
  const byKey = new Map(states.map((s) => [s.itemKey, s]));
  const out: MergeInboxItem[] = [];
  for (const item of items) {
    const state = byKey.get(item.id);
    const snoozed = state?.snoozedUntil && state.snoozedUntil.getTime() > now.getTime() ? state.snoozedUntil : null;
    if (state?.archivedAt && include !== 'archived') continue;
    if (snoozed && include !== 'snoozed') continue;
    out.push({ ...item, read: Boolean(state?.readAt), snoozedUntil: iso(snoozed) });
  }
  return out;
}

export async function buildInbox(db: Db, options: InboxOptions): Promise<MergeInboxItem[]> {
  const { userId, canReadIssues } = options;
  const now = options.now ?? new Date();
  const login = await memberGithubLogin(db, userId);
  const items: MergeInboxItem[] = [];

  const pullRequestItems = async (kind: MergeInboxItem['kind'], where: Array<SQL | undefined>, at: (r: { pr: typeof mergePullRequests.$inferSelect }) => Date) => {
    const rows = await queryPullRequests(db, where, PER_KIND);
    const listItems = await toListItems(db, rows);
    rows.forEach((row, i) => {
      items.push({
        id: `${kind}:${row.pr.id}`,
        kind,
        at: iso(at(row))!,
        pullRequest: listItems[i]!,
        issue: null,
        // The member's own state is applied once the items are collected.
        read: false,
        snoozedUntil: null,
      });
    });
  };

  if (login) {
    await pullRequestItems(
      'review_requested',
      [eq(mergePullRequests.state, 'open'), eq(mergePullRequests.draft, false), reviewRequestedFrom(login)],
      (r) => r.pr.providerUpdatedAt,
    );
  }
  const mine = authoredBy(userId, login);
  await pullRequestItems('checks_failed', [eq(mergePullRequests.state, 'open'), mine, eq(mergePullRequests.checksStatus, 'failure')], (r) => r.pr.providerUpdatedAt);
  await pullRequestItems(
    'changes_requested',
    [eq(mergePullRequests.state, 'open'), mine, eq(mergePullRequests.reviewDecision, 'changes_requested')],
    (r) => r.pr.providerUpdatedAt,
  );
  await pullRequestItems(
    'merged',
    [
      eq(mergePullRequests.state, 'merged'),
      mine,
      gte(mergePullRequests.mergedAt, new Date(now.getTime() - MERGED_DAYS * DAY_MS)),
    ],
    (r) => r.pr.mergedAt ?? r.pr.providerUpdatedAt,
  );

  if (canReadIssues) {
    const rows = await db
      .select()
      .from(mergeIssues)
      .where(
        and(
          eq(mergeIssues.assigneeUserId, userId),
          isNull(mergeIssues.deletedAt),
          gte(mergeIssues.updatedAt, new Date(now.getTime() - ASSIGNED_DAYS * DAY_MS)),
        ),
      )
      .orderBy(desc(mergeIssues.updatedAt), desc(mergeIssues.id))
      .limit(PER_KIND);
    const issues = await hydrateIssues(db, rows);
    rows.forEach((row, i) => {
      items.push({ id: `assigned:${row.id}`, kind: 'assigned', at: iso(row.updatedAt)!, pullRequest: null, issue: issues[i]!, read: false, snoozedUntil: null });
    });
  }

  // Newest first; the id breaks ties so the order is stable.
  return applyStates(db, userId, items.sort(newestFirst), options.include, now);
}

// ---------------------------------------------------------------------------
// Per-member state writes
// ---------------------------------------------------------------------------

function stateDto(row: typeof mergeInboxStates.$inferSelect): MergeInboxItemStateDto {
  return {
    itemKey: row.itemKey,
    read: row.readAt !== null,
    snoozedUntil: iso(row.snoozedUntil),
    archived: row.archivedAt !== null,
  };
}

/**
 * Sets the member's read, snooze and archive state of one item (created on
 * first use). `read: false` marks it unread, `snoozedUntil: null` wakes it,
 * `archived: false` restores it. Only the fields given change.
 */
export async function updateInboxItem(
  db: Db,
  userId: string,
  itemKey: string,
  input: UpdateMergeInboxItemInput,
  now = new Date(),
): Promise<MergeInboxItemStateDto> {
  const patch: Partial<typeof mergeInboxStates.$inferInsert> = {};
  if (input.read !== undefined) patch.readAt = input.read ? now : null;
  if (input.snoozedUntil !== undefined) patch.snoozedUntil = input.snoozedUntil === null ? null : new Date(input.snoozedUntil);
  if (input.archived !== undefined) patch.archivedAt = input.archived ? now : null;
  const [row] = await db
    .insert(mergeInboxStates)
    .values({ id: generateId('mib'), userId, itemKey, createdAt: now, updatedAt: now, ...patch })
    .onConflictDoUpdate({
      target: [mergeInboxStates.userId, mergeInboxStates.itemKey],
      set: { ...patch, updatedAt: now },
    })
    .returning();
  return stateDto(row!);
}

/** Marks every unread item the member can see read; answers how many it marked. */
export async function markInboxRead(db: Db, options: InboxOptions): Promise<number> {
  const now = options.now ?? new Date();
  const items = await buildInbox(db, { ...options, include: undefined, now });
  const unread = items.filter((i) => !i.read);
  for (const item of unread) {
    await db
      .insert(mergeInboxStates)
      .values({ id: generateId('mib'), userId: options.userId, itemKey: item.id, readAt: now, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [mergeInboxStates.userId, mergeInboxStates.itemKey],
        set: { readAt: now, updatedAt: now },
      });
  }
  return unread.length;
}
