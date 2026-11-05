/**
 * The inbox: computed per request, nothing stored (phase 1). Read, snooze and
 * archive need `merge_inbox_states`, which comes in phase 2.
 */

import { and, desc, eq, gte, isNull, type SQL } from 'drizzle-orm';
import type { MergeInboxItem } from '@weldsuite/app-api-client/schemas/weldmerge';
import { iso, mergeIssues, mergePullRequests, type Db } from './db';
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
  now?: Date;
}

/** Descending by time, then by id. */
function newestFirst(a: MergeInboxItem, b: MergeInboxItem): number {
  const [left, right] = a.at === b.at ? [a.id, b.id] : [a.at, b.at];
  return left < right ? 1 : -1;
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
      items.push({ id: `assigned:${row.id}`, kind: 'assigned', at: iso(row.updatedAt)!, pullRequest: null, issue: issues[i]! });
    });
  }

  // Newest first; the id breaks ties so the order is stable.
  return items.sort(newestFirst);
}
