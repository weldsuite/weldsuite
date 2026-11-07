/**
 * The daily digest of one chat subscription: open pull requests waiting for a
 * review, pull requests with failing checks, and issues done in the last day,
 * limited to the subscription's team or repository. A quiet day (all three
 * empty) posts nothing.
 */

import { and, desc, eq, gte, isNull, or, type SQL } from 'drizzle-orm';
import { mergeIssues, mergePullRequests, mergeRepositories, mergeTeams, type Db, type MergeChatSubscriptionRow } from '../db';

/** Most lines one list shows; the rest is counted. */
const MAX_LINES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Digest {
  /** Nothing to report: do not post. */
  empty: boolean;
  content: string;
}

interface PullRequestLine {
  label: string;
  title: string;
}

async function openPullRequests(db: Db, sub: MergeChatSubscriptionRow, extra: SQL): Promise<PullRequestLine[]> {
  const where: Array<SQL | undefined> = [
    eq(mergePullRequests.state, 'open'),
    isNull(mergeRepositories.deletedAt),
    extra,
  ];
  if (sub.repositoryId) where.push(eq(mergePullRequests.repositoryId, sub.repositoryId));
  if (sub.teamId) where.push(eq(mergeRepositories.teamId, sub.teamId));
  const rows = await db
    .select({ pr: mergePullRequests, fullName: mergeRepositories.fullName })
    .from(mergePullRequests)
    .innerJoin(mergeRepositories, eq(mergeRepositories.id, mergePullRequests.repositoryId))
    .where(and(...where))
    .orderBy(desc(mergePullRequests.providerUpdatedAt), desc(mergePullRequests.number), desc(mergePullRequests.id));
  return rows.map((r) => ({ label: `${r.fullName}#${r.pr.number}`, title: r.pr.title }));
}

async function doneIssues(db: Db, sub: MergeChatSubscriptionRow, since: Date): Promise<PullRequestLine[]> {
  // Issues belong to a team, not a repository: a repository subscription has none.
  if (sub.repositoryId) return [];
  const where: Array<SQL | undefined> = [
    eq(mergeIssues.status, 'done'),
    isNull(mergeIssues.deletedAt),
    isNull(mergeTeams.deletedAt),
    gte(mergeIssues.completedAt, since),
  ];
  if (sub.teamId) where.push(eq(mergeIssues.teamId, sub.teamId));
  const rows = await db
    .select({ issue: mergeIssues, teamKey: mergeTeams.key })
    .from(mergeIssues)
    .innerJoin(mergeTeams, eq(mergeTeams.id, mergeIssues.teamId))
    .where(and(...where))
    .orderBy(desc(mergeIssues.completedAt), desc(mergeIssues.number), desc(mergeIssues.id));
  return rows.map((r) => ({ label: `${r.teamKey}-${r.issue.number}`, title: r.issue.title }));
}

function section(heading: string, lines: PullRequestLine[]): string | null {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, MAX_LINES).map((l) => `- ${l.label} ${l.title}`);
  if (lines.length > MAX_LINES) shown.push(`- and ${lines.length - MAX_LINES} more`);
  return `${heading} (${lines.length})\n${shown.join('\n')}`;
}

export async function buildDigest(db: Db, sub: MergeChatSubscriptionRow, now: Date): Promise<Digest> {
  const waiting = await openPullRequests(
    db,
    sub,
    and(eq(mergePullRequests.draft, false), or(isNull(mergePullRequests.reviewDecision), eq(mergePullRequests.reviewDecision, 'review_required')))!,
  );
  const failing = await openPullRequests(db, sub, eq(mergePullRequests.checksStatus, 'failure'));
  const done = await doneIssues(db, sub, new Date(now.getTime() - DAY_MS));

  const sections = [
    section('Waiting for review', waiting),
    section('Checks failing', failing),
    section('Done in the last day', done),
  ].filter((s): s is string => s !== null);
  if (sections.length === 0) return { empty: true, content: '' };
  return { empty: false, content: `WeldMerge daily digest\n\n${sections.join('\n\n')}` };
}
