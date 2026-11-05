/** Reading the pull request mirror, and linking pull requests to issues by hand. */

import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { pullRequestPhase } from '@weldsuite/merge-domain/automation';
import type {
  ListMergePullRequestsQuery,
  MergeIssueLink,
  MergePullRequestDetailDto,
  MergePullRequestListItem,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  iso,
  likePattern,
  mergeIssuePullRequests,
  mergeIssues,
  mergePullRequests,
  mergeProviderAccounts,
  mergeRepositories,
  mergeTeams,
  type Db,
  type MergeIssueRow,
  type MergePullRequestRow,
} from './db';
import type { PendingEvent } from './events';
import { issueEventData, pullRequestSummary } from './mappers';
import { runAutomation, type LinkedIssue } from './pr-sync';

/** The member's own GitHub login (lower-case), or null. */
export async function memberGithubLogin(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ login: mergeProviderAccounts.login })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.userId, userId), eq(mergeProviderAccounts.provider, 'github')))
    .limit(1);
  return row?.login ?? null;
}

/** The issues each pull request is linked to (live issues only). */
export async function linkedIssuesByPullRequest(db: Db, pullRequestIds: string[]): Promise<Map<string, MergeIssueLink[]>> {
  const out = new Map<string, MergeIssueLink[]>();
  if (pullRequestIds.length === 0) return out;
  const rows = await db
    .select({
      pullRequestId: mergeIssuePullRequests.pullRequestId,
      issue: mergeIssues,
      teamKey: mergeTeams.key,
      source: mergeIssuePullRequests.source,
      closes: mergeIssuePullRequests.closes,
    })
    .from(mergeIssuePullRequests)
    .innerJoin(mergeIssues, eq(mergeIssues.id, mergeIssuePullRequests.issueId))
    .innerJoin(mergeTeams, eq(mergeTeams.id, mergeIssues.teamId))
    .where(and(inArray(mergeIssuePullRequests.pullRequestId, pullRequestIds), isNull(mergeIssues.deletedAt)))
    .orderBy(mergeTeams.key, mergeIssues.number);
  for (const r of rows) {
    const list = out.get(r.pullRequestId) ?? [];
    list.push({
      id: r.issue.id,
      key: `${r.teamKey}-${r.issue.number}`,
      title: r.issue.title,
      status: r.issue.status,
      source: r.source,
      closes: r.closes,
    });
    out.set(r.pullRequestId, list);
  }
  return out;
}

export interface PullRequestRowWithRepo {
  pr: MergePullRequestRow;
  repositoryFullName: string;
  teamId: string | null;
}

export async function toListItems(db: Db, rows: PullRequestRowWithRepo[]): Promise<MergePullRequestListItem[]> {
  const issues = await linkedIssuesByPullRequest(
    db,
    rows.map((r) => r.pr.id),
  );
  return rows.map((r) => ({
    ...pullRequestSummary(r.pr, r.repositoryFullName),
    teamId: r.teamId,
    issues: issues.get(r.pr.id) ?? [],
  }));
}

/** The member's open, non-draft pull requests that ask them for a review, as a SQL condition. */
export function reviewRequestedFrom(login: string): SQL {
  return sql`${mergePullRequests.requestedReviewers} @> ${JSON.stringify([{ kind: 'user', login }])}::jsonb`;
}

export function authoredBy(userId: string, login: string | null): SQL {
  const byUser = eq(mergePullRequests.authorUserId, userId);
  return (login ? or(byUser, eq(mergePullRequests.authorLogin, login)) : byUser) as SQL;
}

const SELECT_WITH_REPO = {
  pr: mergePullRequests,
  repositoryFullName: mergeRepositories.fullName,
  teamId: mergeRepositories.teamId,
};

export async function queryPullRequests(db: Db, where: Array<SQL | undefined>, limit: number): Promise<PullRequestRowWithRepo[]> {
  return db
    .select(SELECT_WITH_REPO)
    .from(mergePullRequests)
    .innerJoin(mergeRepositories, eq(mergeRepositories.id, mergePullRequests.repositoryId))
    .where(and(isNull(mergeRepositories.deletedAt), ...where))
    .orderBy(desc(mergePullRequests.providerUpdatedAt), desc(mergePullRequests.id))
    .limit(limit);
}

function parseCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.indexOf('|');
  const ms = Number(cursor.slice(0, sep));
  if (sep < 1 || !Number.isFinite(ms)) return null;
  return { at: new Date(ms).toISOString(), id: cursor.slice(sep + 1) };
}

export interface PullRequestListResult {
  items: MergePullRequestListItem[];
  hasMore: boolean;
  cursor: string | null;
}

export async function listPullRequests(
  db: Db,
  query: ListMergePullRequestsQuery & { limit: number },
  userId: string,
): Promise<PullRequestListResult> {
  const view = query.view ?? 'open';
  const where: Array<SQL | undefined> = [];

  if (view === 'needs_review' || view === 'mine') {
    const login = await memberGithubLogin(db, userId);
    if (view === 'needs_review') {
      if (!login) return { items: [], hasMore: false, cursor: null };
      where.push(eq(mergePullRequests.state, 'open'), eq(mergePullRequests.draft, false), reviewRequestedFrom(login));
    } else {
      where.push(eq(mergePullRequests.state, 'open'), authoredBy(userId, login));
    }
  } else if (view === 'open') {
    where.push(eq(mergePullRequests.state, 'open'));
  } else {
    where.push(eq(mergePullRequests.state, view));
  }

  if (query.repositoryId) where.push(eq(mergePullRequests.repositoryId, query.repositoryId));
  if (query.teamId) where.push(eq(mergeRepositories.teamId, query.teamId));
  if (query.q) {
    const pattern = likePattern(query.q);
    const number = /^#?(\d{1,9})$/.exec(query.q.trim());
    where.push(
      or(
        sql`${mergePullRequests.title} ilike ${pattern} escape '\\'`,
        sql`${mergePullRequests.headRef} ilike ${pattern} escape '\\'`,
        sql`${mergeRepositories.fullName} ilike ${pattern} escape '\\'`,
        number ? eq(mergePullRequests.number, Number(number[1])) : undefined,
      ),
    );
  }
  const cursor = parseCursor(query.cursor);
  if (cursor) {
    where.push(
      sql`(${mergePullRequests.providerUpdatedAt}, ${mergePullRequests.id}) < (${cursor.at}::timestamptz, ${cursor.id}::varchar)`,
    );
  }

  const rows = await queryPullRequests(db, where, query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: await toListItems(db, page),
    hasMore,
    cursor: hasMore && last ? `${last.pr.providerUpdatedAt.getTime()}|${last.pr.id}` : null,
  };
}

export async function findPullRequest(db: Db, id: string): Promise<PullRequestRowWithRepo | null> {
  const [row] = await db
    .select(SELECT_WITH_REPO)
    .from(mergePullRequests)
    .innerJoin(mergeRepositories, eq(mergeRepositories.id, mergePullRequests.repositoryId))
    .where(and(eq(mergePullRequests.id, id), isNull(mergeRepositories.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function getPullRequestDetail(db: Db, id: string): Promise<MergePullRequestDetailDto | null> {
  const row = await findPullRequest(db, id);
  if (!row) return null;
  const issues = await linkedIssuesByPullRequest(db, [id]);
  return {
    ...pullRequestSummary(row.pr, row.repositoryFullName),
    body: row.pr.body,
    headSha: row.pr.headSha,
    teamId: row.teamId,
    issues: issues.get(id) ?? [],
    syncedAt: iso(row.pr.syncedAt)!,
  };
}

// ---------------------------------------------------------------------------
// Manual links
// ---------------------------------------------------------------------------

export type LinkResult =
  | { ok: true; events: PendingEvent[] }
  | { ok: false; reason: 'pull_request_not_found' };

/** Links by hand (source `manual`). A new link runs the automation rule for the pull request's current phase. */
export async function linkPullRequest(
  db: Db,
  issue: MergeIssueRow,
  teamKey: string,
  pullRequestId: string,
  closes: boolean,
  userId: string,
): Promise<LinkResult> {
  const target = await findPullRequest(db, pullRequestId);
  if (!target) return { ok: false, reason: 'pull_request_not_found' };

  const [existing] = await db
    .select()
    .from(mergeIssuePullRequests)
    .where(and(eq(mergeIssuePullRequests.issueId, issue.id), eq(mergeIssuePullRequests.pullRequestId, pullRequestId)))
    .limit(1);

  let events: PendingEvent[] = [];
  if (existing) {
    await db.update(mergeIssuePullRequests).set({ closes }).where(eq(mergeIssuePullRequests.id, existing.id));
  } else {
    await db
      .insert(mergeIssuePullRequests)
      .values({ id: generateId('mip'), issueId: issue.id, pullRequestId, source: 'manual', closes, createdByUserId: userId })
      .onConflictDoNothing();
    const phase = pullRequestPhase(target.pr);
    const link: LinkedIssue = { linkId: '', closes, source: 'manual', isNew: true, issue, teamKey };
    events = await runAutomation(db, target.pr, phase, [link]);
  }
  if (events.length === 0) {
    events = [
      {
        entityType: 'merge_issue',
        action: 'updated',
        entityId: issue.id,
        data: issueEventData(issue, teamKey),
      },
    ];
  }
  return { ok: true, events };
}

/** Removes a link. An `auto` link comes back when the pull request next syncs and still mentions the key. */
export async function unlinkPullRequest(db: Db, issueId: string, pullRequestId: string): Promise<boolean> {
  const removed = await db
    .delete(mergeIssuePullRequests)
    .where(and(eq(mergeIssuePullRequests.issueId, issueId), eq(mergeIssuePullRequests.pullRequestId, pullRequestId)))
    .returning({ id: mergeIssuePullRequests.id });
  return removed.length > 0;
}
