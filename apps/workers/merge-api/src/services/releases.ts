/**
 * Releases: a named set of merged pull requests of one repository, with notes.
 *
 * No Hono context in here: functions return rows and tagged failures, and the
 * route maps them to responses and publishes the entity events.
 *
 * Which pull requests a release holds (`refresh`):
 *   1. GitHub with both refs set: the compare API
 *      (`GET /repos/{owner}/{repo}/compare/{base}...{head}`) lists the commits;
 *      a merged mirror belongs to the release when its head commit is among them
 *      or a commit message names it (`Merge pull request #12 ...`, `title (#12)`).
 *      The mirror stores no merge commit sha, so this is what a merge, squash
 *      and fast-forward merge leave behind.
 *   2. Anything else (other providers, a release without refs, a compare GitHub
 *      does not know): the repository's pull requests merged since the previous
 *      shipped release of that repository (all of them, newest 200, when there
 *      is none).
 */

import { and, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MergeIssueDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import type {
  CreateMergeReleaseInput,
  ListMergeReleasesQuery,
  MergeReleaseDetailDto,
  MergeReleaseDto,
  MergeReleaseShippedEventData,
  MergeReleaseTicket,
  UpdateMergeReleaseInput,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import {
  iso,
  mergeIssuePullRequests,
  mergeIssues,
  mergePullRequests,
  mergeRecordLinks,
  mergeReleasePullRequests,
  mergeReleases,
  mergeRepositories,
  type Db,
  type MergePullRequestRow,
  type MergeReleaseRow,
  type MergeRepositoryRow,
} from './db';
import type { GithubClient } from './github-client';
import { hydrateIssues } from './issues';
import { pullRequestSummary } from './mappers';
import { findTeam } from './teams';

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function releaseDto(row: MergeReleaseRow, repositoryFullName: string, pullRequestCount: number): MergeReleaseDto {
  return {
    id: row.id,
    teamId: row.teamId,
    repositoryId: row.repositoryId,
    repositoryFullName,
    name: row.name,
    version: row.version,
    baseRef: row.baseRef,
    headRef: row.headRef,
    status: row.status,
    notes: row.notes,
    notesGeneratedAt: iso(row.notesGeneratedAt),
    knowledgePageId: row.knowledgePageId,
    shippedAt: iso(row.shippedAt),
    pullRequestCount,
    createdByUserId: row.createdByUserId,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

/** What a release's entity event carries (no notes: they can be long). */
export function releaseEventData(row: MergeReleaseRow) {
  return {
    id: row.id,
    teamId: row.teamId,
    repositoryId: row.repositoryId,
    name: row.name,
    version: row.version,
    status: row.status,
  };
}

export const RELEASE_CHANGE_FIELDS = ['name', 'version', 'baseRef', 'headRef', 'notes'] as const;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function findRelease(db: Db, id: string): Promise<MergeReleaseRow | null> {
  const [row] = await db
    .select()
    .from(mergeReleases)
    .where(and(eq(mergeReleases.id, id), isNull(mergeReleases.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Repositories by id, deleted ones too (a release keeps its repository's name). */
async function repositoryNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: mergeRepositories.id, fullName: mergeRepositories.fullName })
    .from(mergeRepositories)
    .where(inArray(mergeRepositories.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

async function pullRequestCounts(db: Db, releaseIds: string[]): Promise<Map<string, number>> {
  if (releaseIds.length === 0) return new Map();
  const rows = await db
    .select({ releaseId: mergeReleasePullRequests.releaseId, count: sql<number>`count(*)::int` })
    .from(mergeReleasePullRequests)
    .where(inArray(mergeReleasePullRequests.releaseId, releaseIds))
    .groupBy(mergeReleasePullRequests.releaseId);
  return new Map(rows.map((r) => [r.releaseId, r.count]));
}

export async function hydrateReleases(db: Db, rows: MergeReleaseRow[]): Promise<MergeReleaseDto[]> {
  if (rows.length === 0) return [];
  const names = await repositoryNames(
    db,
    rows.map((r) => r.repositoryId),
  );
  const counts = await pullRequestCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => releaseDto(row, names.get(row.repositoryId) ?? '', counts.get(row.id) ?? 0));
}

export async function oneReleaseDto(db: Db, row: MergeReleaseRow): Promise<MergeReleaseDto> {
  const [dto] = await hydrateReleases(db, [row]);
  return dto!;
}

export interface ReleaseListResult {
  rows: MergeReleaseRow[];
  hasMore: boolean;
  cursor: string | null;
}

/** Newest first (by id, which leads with the creation time); the cursor is the last id of the page. */
export async function listReleases(db: Db, query: Omit<ListMergeReleasesQuery, 'limit'> & { limit: number }): Promise<ReleaseListResult> {
  const where: Array<SQL | undefined> = [isNull(mergeReleases.deletedAt)];
  if (query.teamId) where.push(eq(mergeReleases.teamId, query.teamId));
  if (query.repositoryId) where.push(eq(mergeReleases.repositoryId, query.repositoryId));
  if (query.status) where.push(eq(mergeReleases.status, query.status));
  if (query.cursor) where.push(lt(mergeReleases.id, query.cursor));
  const rows = await db
    .select()
    .from(mergeReleases)
    .where(and(...where))
    .orderBy(desc(mergeReleases.id))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return { rows: page, hasMore, cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

interface ReleaseContents {
  pullRequests: Array<{ row: MergePullRequestRow; repositoryFullName: string }>;
  issues: MergeIssueDto[];
  tickets: MergeReleaseTicket[];
}

/** The pull requests of a release, the issues they link to and the desk tickets linked to those issues. */
async function releaseContents(db: Db, releaseId: string): Promise<ReleaseContents> {
  const prs = await db
    .select({ pr: mergePullRequests, repositoryFullName: mergeRepositories.fullName })
    .from(mergeReleasePullRequests)
    .innerJoin(mergePullRequests, eq(mergePullRequests.id, mergeReleasePullRequests.pullRequestId))
    .innerJoin(mergeRepositories, eq(mergeRepositories.id, mergePullRequests.repositoryId))
    .where(eq(mergeReleasePullRequests.releaseId, releaseId))
    .orderBy(desc(mergePullRequests.mergedAt), desc(mergePullRequests.id));
  const pullRequests = prs.map((r) => ({ row: r.pr, repositoryFullName: r.repositoryFullName }));
  if (pullRequests.length === 0) return { pullRequests, issues: [], tickets: [] };

  const issueRows = await db
    .selectDistinct({ issue: mergeIssues })
    .from(mergeIssuePullRequests)
    .innerJoin(mergeIssues, eq(mergeIssues.id, mergeIssuePullRequests.issueId))
    .where(
      and(
        inArray(
          mergeIssuePullRequests.pullRequestId,
          pullRequests.map((p) => p.row.id),
        ),
        isNull(mergeIssuePullRequests.dismissedAt),
        isNull(mergeIssues.deletedAt),
      ),
    );
  const issues = (await hydrateIssues(db, issueRows.map((r) => r.issue))).sort((a, b) => (a.key < b.key ? -1 : 1));
  const tickets = await deskTicketsOf(db, issues);
  return { pullRequests, issues, tickets };
}

const compareText = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

async function deskTicketsOf(db: Db, issues: MergeIssueDto[]): Promise<MergeReleaseTicket[]> {
  if (issues.length === 0) return [];
  const links = await db
    .select()
    .from(mergeRecordLinks)
    .where(
      and(
        inArray(
          mergeRecordLinks.issueId,
          issues.map((i) => i.id),
        ),
        eq(mergeRecordLinks.recordType, 'desk_ticket'),
      ),
    );
  const keys = new Map(issues.map((i) => [i.id, i.key]));
  return links
    .map((l) => ({ ticketId: l.recordId, title: l.title, issueId: l.issueId, issueKey: keys.get(l.issueId) ?? '' }))
    .sort((a, b) => compareText(a.issueKey, b.issueKey) || compareText(a.ticketId, b.ticketId));
}

export async function getReleaseDetail(db: Db, row: MergeReleaseRow): Promise<MergeReleaseDetailDto> {
  const base = await oneReleaseDto(db, row);
  const contents = await releaseContents(db, row.id);
  return {
    ...base,
    pullRequests: contents.pullRequests.map((p) => pullRequestSummary(p.row, p.repositoryFullName)),
    issues: contents.issues,
    tickets: contents.tickets,
  };
}

/** The payload of `merge_release.shipped`: pull request, issue and desk ticket ids. */
export async function shippedEventData(db: Db, row: MergeReleaseRow): Promise<MergeReleaseShippedEventData> {
  const contents = await releaseContents(db, row.id);
  return {
    releaseId: row.id,
    name: row.name,
    version: row.version,
    repositoryId: row.repositoryId,
    pullRequestIds: contents.pullRequests.map((p) => p.row.id),
    issueIds: contents.issues.map((i) => i.id),
    deskTicketIds: [...new Set(contents.tickets.map((t) => t.ticketId))],
  };
}

/** What the notes are written from. */
export interface NotesSource {
  release: MergeReleaseRow;
  repositoryFullName: string;
  pullRequests: Array<{ number: number; title: string; authorLogin: string | null; repositoryFullName: string }>;
  issues: Array<{ key: string; title: string }>;
}

export async function notesSource(db: Db, release: MergeReleaseRow): Promise<NotesSource> {
  const contents = await releaseContents(db, release.id);
  const names = await repositoryNames(db, [release.repositoryId]);
  return {
    release,
    repositoryFullName: names.get(release.repositoryId) ?? '',
    pullRequests: contents.pullRequests.map((p) => ({
      number: p.row.number,
      title: p.row.title,
      authorLogin: p.row.authorLogin,
      repositoryFullName: p.repositoryFullName,
    })),
    issues: contents.issues.map((i) => ({ key: i.key, title: i.title })),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type ReleaseCreateResult =
  | { ok: true; release: MergeReleaseRow }
  | { ok: false; reason: 'team_not_found' | 'repository_not_found' };

export async function createRelease(db: Db, input: CreateMergeReleaseInput, userId: string): Promise<ReleaseCreateResult> {
  if (!(await findTeam(db, input.teamId))) return { ok: false, reason: 'team_not_found' };
  const repository = await findLiveRepository(db, input.repositoryId);
  if (!repository) return { ok: false, reason: 'repository_not_found' };
  const now = new Date();
  const [release] = await db
    .insert(mergeReleases)
    .values({
      id: generateId('mrl'),
      teamId: input.teamId,
      repositoryId: input.repositoryId,
      name: input.name.trim(),
      version: input.version?.trim() || null,
      baseRef: input.baseRef?.trim() || null,
      headRef: input.headRef?.trim() || null,
      notes: input.notes ?? null,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { ok: true, release: release! };
}

export async function findLiveRepository(db: Db, id: string): Promise<MergeRepositoryRow | null> {
  const [row] = await db
    .select()
    .from(mergeRepositories)
    .where(and(eq(mergeRepositories.id, id), isNull(mergeRepositories.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function updateRelease(db: Db, id: string, input: UpdateMergeReleaseInput) {
  const before = await findRelease(db, id);
  if (!before) return null;
  const patch: Partial<typeof mergeReleases.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.version !== undefined) patch.version = input.version?.trim() || null;
  if (input.baseRef !== undefined) patch.baseRef = input.baseRef?.trim() || null;
  if (input.headRef !== undefined) patch.headRef = input.headRef?.trim() || null;
  if (input.notes !== undefined) patch.notes = input.notes;
  const [release] = await db.update(mergeReleases).set(patch).where(eq(mergeReleases.id, id)).returning();
  return { before, release: release! };
}

export async function deleteRelease(db: Db, id: string): Promise<MergeReleaseRow | null> {
  const now = new Date();
  const [row] = await db
    .update(mergeReleases)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(mergeReleases.id, id), isNull(mergeReleases.deletedAt)))
    .returning();
  return row ?? null;
}

/**
 * Ships a draft release. Only a live draft ships: undefined when the release
 * was shipped or deleted meanwhile (a second click, a concurrent request), so
 * `merge_release.shipped` and the chat post go out once.
 */
export async function markShipped(db: Db, id: string): Promise<MergeReleaseRow | undefined> {
  const now = new Date();
  const [row] = await db
    .update(mergeReleases)
    .set({ status: 'shipped', shippedAt: now, updatedAt: now })
    .where(and(eq(mergeReleases.id, id), eq(mergeReleases.status, 'draft'), isNull(mergeReleases.deletedAt)))
    .returning();
  return row;
}

export async function saveNotes(db: Db, id: string, notes: string): Promise<MergeReleaseRow> {
  const now = new Date();
  const [row] = await db
    .update(mergeReleases)
    .set({ notes, notesGeneratedAt: now, updatedAt: now })
    .where(eq(mergeReleases.id, id))
    .returning();
  return row!;
}

export async function saveKnowledgePage(db: Db, id: string, pageId: string): Promise<MergeReleaseRow> {
  const [row] = await db
    .update(mergeReleases)
    .set({ knowledgePageId: pageId, updatedAt: new Date() })
    .where(eq(mergeReleases.id, id))
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

const COMPARE_PAGE = 100;
const COMPARE_MAX_PAGES = 5;
const FALLBACK_CAP = 200;

interface CompareCommit {
  sha: string;
  commit?: { message?: string | null } | null;
}

interface CompareBody {
  commits?: CompareCommit[];
}

/** A ref as a URL path: each segment encoded, the slashes kept (`feature/x`). */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** Commits between the refs (up to 500), or null when GitHub does not know the compare. */
async function compareCommits(client: GithubClient, fullName: string, base: string, head: string): Promise<CompareCommit[] | null> {
  const out: CompareCommit[] = [];
  for (let page = 1; page <= COMPARE_MAX_PAGES; page++) {
    const body = await client.get<CompareBody>(
      `/repos/${fullName}/compare/${refPath(base)}...${refPath(head)}?per_page=${COMPARE_PAGE}&page=${page}`,
    );
    if (!body) return page === 1 ? null : out;
    const commits = body.commits ?? [];
    out.push(...commits);
    if (commits.length < COMPARE_PAGE) break;
  }
  return out;
}

const MERGE_COMMIT_RE = /^Merge pull request #(\d+)\b/;
const SQUASH_SUFFIX_RE = /\(#(\d+)\)\s*$/;

/** The pull request number a merge or squash commit message names, if any. */
export function pullRequestNumberOf(message: string | null | undefined): number | null {
  const first = (message ?? '').split('\n', 1)[0]?.trim() ?? '';
  const match = MERGE_COMMIT_RE.exec(first) ?? SQUASH_SUFFIX_RE.exec(first);
  return match ? Number(match[1]) : null;
}

async function mergedByCompare(db: Db, repositoryId: string, commits: CompareCommit[]): Promise<MergePullRequestRow[]> {
  const shas = commits.map((c) => c.sha);
  const numbers = [...new Set(commits.flatMap((c) => pullRequestNumberOf(c.commit?.message) ?? []))];
  if (shas.length === 0) return [];
  const byRef: SQL[] = [inArray(mergePullRequests.headSha, shas)];
  if (numbers.length > 0) byRef.push(inArray(mergePullRequests.number, numbers));
  return db
    .select()
    .from(mergePullRequests)
    .where(
      and(
        eq(mergePullRequests.repositoryId, repositoryId),
        eq(mergePullRequests.state, 'merged'),
        or(...byRef),
      ),
    )
    .orderBy(desc(mergePullRequests.mergedAt), desc(mergePullRequests.id));
}

/** The previous shipped release of the repository: where the fallback starts. */
async function previousShippedAt(db: Db, release: MergeReleaseRow): Promise<Date | null> {
  const [row] = await db
    .select({ shippedAt: mergeReleases.shippedAt })
    .from(mergeReleases)
    .where(
      and(
        eq(mergeReleases.repositoryId, release.repositoryId),
        eq(mergeReleases.status, 'shipped'),
        isNull(mergeReleases.deletedAt),
        ne(mergeReleases.id, release.id),
      ),
    )
    .orderBy(desc(mergeReleases.shippedAt))
    .limit(1);
  return row?.shippedAt ?? null;
}

async function mergedSince(db: Db, release: MergeReleaseRow): Promise<MergePullRequestRow[]> {
  const since = await previousShippedAt(db, release);
  const where: Array<SQL | undefined> = [
    eq(mergePullRequests.repositoryId, release.repositoryId),
    eq(mergePullRequests.state, 'merged'),
  ];
  if (since) where.push(sql`${mergePullRequests.mergedAt} > ${since.toISOString()}::timestamptz`);
  return db
    .select()
    .from(mergePullRequests)
    .where(and(...where))
    .orderBy(desc(mergePullRequests.mergedAt), desc(mergePullRequests.id))
    .limit(FALLBACK_CAP);
}

export type RefreshMethod = 'compare' | 'fallback';

export interface RefreshOutcome {
  release: MergeReleaseRow;
  method: RefreshMethod;
  pullRequestIds: string[];
}

/**
 * Re-reads which merged pull requests the release holds and replaces its list.
 * `client` is the repository's GitHub client (null for any other provider).
 */
export async function refreshRelease(
  db: Db,
  release: MergeReleaseRow,
  repository: MergeRepositoryRow,
  client: GithubClient | null,
): Promise<RefreshOutcome> {
  let method: RefreshMethod = 'fallback';
  let found: MergePullRequestRow[] | null = null;
  if (client && repository.provider === 'github' && release.baseRef && release.headRef) {
    const commits = await compareCommits(client, repository.fullName, release.baseRef, release.headRef);
    if (commits) {
      method = 'compare';
      found = await mergedByCompare(db, repository.id, commits);
    }
  }
  const pullRequests = found ?? (await mergedSince(db, release));

  await db.delete(mergeReleasePullRequests).where(eq(mergeReleasePullRequests.releaseId, release.id));
  if (pullRequests.length > 0) {
    const now = new Date();
    await db
      .insert(mergeReleasePullRequests)
      .values(pullRequests.map((pr) => ({ id: generateId('mrr'), releaseId: release.id, pullRequestId: pr.id, createdAt: now })))
      .onConflictDoNothing();
  }
  const [updated] = await db
    .update(mergeReleases)
    .set({ updatedAt: new Date() })
    .where(eq(mergeReleases.id, release.id))
    .returning();
  return { release: updated!, method, pullRequestIds: pullRequests.map((p) => p.id) };
}
