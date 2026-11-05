/**
 * Issues: WeldMerge's own records (ADR MERGE-003), keyed `<team key>-<number>`.
 *
 * No Hono context in here: functions return rows and tagged failures, and the
 * route maps them to responses and publishes the entity events.
 */

import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { parseIssueKey } from '@weldsuite/merge-domain/keys';
import { statusTimestamps } from '@weldsuite/merge-domain/automation';
import type { z } from 'zod';
import type {
  CreateMergeIssueInput,
  CreateMergeRecordLinkInput,
  MergeIssueDetailDto,
  MergeIssueDto,
  UpdateMergeIssueInput,
  listMergeIssuesQuerySchema,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  executeRows,
  iso,
  likePattern,
  mergeCycles,
  mergeExternalIssues,
  mergeIssuePullRequests,
  mergeIssues,
  mergeLabels,
  mergePullRequests,
  mergeRecordLinks,
  mergeRepositories,
  mergeTeams,
  type Db,
  type MergeIssueRow,
  type MergeRecordLinkRow,
  type MergeTeamRow,
} from './db';
import { issueDto, pullRequestSummary, recordLinkDto } from './mappers';
import { findTeam } from './teams';

/** The validated query: statuses already split, limit defaulted. */
export type ListIssuesQuery = z.output<typeof listMergeIssuesQuerySchema>;

export type IssueRefFailure = 'cycle_invalid' | 'parent_invalid' | 'labels_invalid';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Issue rows to DTOs: the team key and the linked pull request count. */
export async function hydrateIssues(db: Db, rows: MergeIssueRow[]): Promise<MergeIssueDto[]> {
  if (rows.length === 0) return [];
  const teamIds = [...new Set(rows.map((r) => r.teamId))];
  const teams = await db.select({ id: mergeTeams.id, key: mergeTeams.key }).from(mergeTeams).where(inArray(mergeTeams.id, teamIds));
  const keys = new Map(teams.map((t) => [t.id, t.key]));
  const counts = await db
    .select({ issueId: mergeIssuePullRequests.issueId, count: sql<number>`count(*)::int` })
    .from(mergeIssuePullRequests)
    .where(
      and(
        inArray(
          mergeIssuePullRequests.issueId,
          rows.map((r) => r.id),
        ),
        isNull(mergeIssuePullRequests.dismissedAt),
      ),
    )
    .groupBy(mergeIssuePullRequests.issueId);
  const prCounts = new Map(counts.map((c) => [c.issueId, c.count]));
  return rows.map((row) => issueDto(row, keys.get(row.teamId) ?? '', prCounts.get(row.id) ?? 0));
}

export async function findIssue(db: Db, id: string): Promise<MergeIssueRow | null> {
  const [row] = await db
    .select()
    .from(mergeIssues)
    .where(and(eq(mergeIssues.id, id), isNull(mergeIssues.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** By id, or by key (`PLAT-209`). */
export async function findIssueByIdOrKey(db: Db, idOrKey: string): Promise<MergeIssueRow | null> {
  const key = parseIssueKey(idOrKey);
  if (!key) return findIssue(db, idOrKey);
  const [row] = await db
    .select({ issue: mergeIssues })
    .from(mergeIssues)
    .innerJoin(mergeTeams, eq(mergeTeams.id, mergeIssues.teamId))
    .where(
      and(
        eq(mergeTeams.key, key.teamKey),
        isNull(mergeTeams.deletedAt),
        eq(mergeIssues.number, key.number),
        isNull(mergeIssues.deletedAt),
      ),
    )
    .limit(1);
  return row?.issue ?? null;
}

export async function getIssueDetail(db: Db, idOrKey: string): Promise<MergeIssueDetailDto | null> {
  const row = await findIssueByIdOrKey(db, idOrKey);
  if (!row) return null;
  const subRows = await db
    .select()
    .from(mergeIssues)
    .where(and(eq(mergeIssues.parentIssueId, row.id), isNull(mergeIssues.deletedAt)))
    .orderBy(asc(mergeIssues.number));
  const [base] = await hydrateIssues(db, [row]);
  const subIssues = await hydrateIssues(db, subRows);

  const linked = await db
    .select({
      pr: mergePullRequests,
      repositoryFullName: mergeRepositories.fullName,
      source: mergeIssuePullRequests.source,
      closes: mergeIssuePullRequests.closes,
    })
    .from(mergeIssuePullRequests)
    .innerJoin(mergePullRequests, eq(mergePullRequests.id, mergeIssuePullRequests.pullRequestId))
    .innerJoin(mergeRepositories, eq(mergeRepositories.id, mergePullRequests.repositoryId))
    .where(
      and(
        eq(mergeIssuePullRequests.issueId, row.id),
        isNull(mergeIssuePullRequests.dismissedAt),
        isNull(mergeRepositories.deletedAt),
      ),
    )
    .orderBy(desc(mergePullRequests.providerUpdatedAt), desc(mergePullRequests.id));

  const [external] = await db
    .select({ link: mergeExternalIssues, repositoryFullName: mergeRepositories.fullName })
    .from(mergeExternalIssues)
    .innerJoin(mergeRepositories, eq(mergeRepositories.id, mergeExternalIssues.repositoryId))
    .where(eq(mergeExternalIssues.issueId, row.id))
    .limit(1);
  const recordLinks = await listRecordLinks(db, row.id);

  return {
    ...base!,
    external: external
      ? {
          provider: external.link.provider,
          number: external.link.number,
          url: external.link.url,
          state: external.link.state,
          repositoryId: external.link.repositoryId,
          repositoryFullName: external.repositoryFullName,
        }
      : null,
    recordLinks: recordLinks.map(recordLinkDto),
    pullRequests: linked.map((l) => ({
      ...pullRequestSummary(l.pr, l.repositoryFullName),
      link: { source: l.source, closes: l.closes },
    })),
    subIssues,
  };
}

export interface IssueListResult {
  rows: MergeIssueRow[];
  hasMore: boolean;
  cursor: string | null;
}

/** Newest first (by id, which leads with the creation time); the cursor is the last id of the page. */
function assigneeFilter(assignee: string, userId: string): SQL {
  if (assignee === 'none') return isNull(mergeIssues.assigneeUserId);
  if (assignee === 'me') return eq(mergeIssues.assigneeUserId, userId);
  return eq(mergeIssues.assigneeUserId, assignee);
}

/** The structural filters of the list: everything but the free-text search and the cursor. */
function issueFilters(query: ListIssuesQuery, userId: string): Array<SQL | undefined> {
  const where: Array<SQL | undefined> = [isNull(mergeIssues.deletedAt)];
  if (query.teamId) where.push(eq(mergeIssues.teamId, query.teamId));
  if (query.status && query.status.length > 0) where.push(inArray(mergeIssues.status, query.status as MergeIssueRow['status'][]));
  if (query.assignee) where.push(assigneeFilter(query.assignee, userId));
  if (query.cycleId) where.push(eq(mergeIssues.cycleId, query.cycleId));
  if (query.labelId) where.push(sql`${mergeIssues.labelIds} @> ${JSON.stringify([query.labelId])}::jsonb`);
  if (query.parentIssueId) where.push(eq(mergeIssues.parentIssueId, query.parentIssueId));
  return where;
}

/** Free-text search: the title, or a team key + number such as `ENG-12`. */
async function searchFilter(db: Db, q: string): Promise<SQL | undefined> {
  const titleMatch = sql`${mergeIssues.title} ilike ${likePattern(q)} escape '\\'`;
  const key = parseIssueKey(q);
  if (!key) return titleMatch;
  const [team] = await db
    .select({ id: mergeTeams.id })
    .from(mergeTeams)
    .where(and(eq(mergeTeams.key, key.teamKey), isNull(mergeTeams.deletedAt)))
    .limit(1);
  return team ? or(titleMatch, and(eq(mergeIssues.teamId, team.id), eq(mergeIssues.number, key.number))) : titleMatch;
}

export async function listIssues(
  db: Db,
  query: ListIssuesQuery,
  userId: string,
): Promise<IssueListResult> {
  const where = issueFilters(query, userId);
  if (query.q) where.push(await searchFilter(db, query.q));
  if (query.cursor) where.push(lt(mergeIssues.id, query.cursor));

  const rows = await db
    .select()
    .from(mergeIssues)
    .where(and(...where))
    .orderBy(desc(mergeIssues.id))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return { rows: page, hasMore, cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

// ---------------------------------------------------------------------------
// Validation of references
// ---------------------------------------------------------------------------

async function validateCycle(db: Db, teamId: string, cycleId: string): Promise<IssueRefFailure | null> {
  const [cycle] = await db
    .select({ id: mergeCycles.id })
    .from(mergeCycles)
    .where(and(eq(mergeCycles.id, cycleId), eq(mergeCycles.teamId, teamId), isNull(mergeCycles.deletedAt)))
    .limit(1);
  return cycle ? null : 'cycle_invalid';
}

async function validateParent(db: Db, teamId: string, parentIssueId: string, selfId?: string): Promise<IssueRefFailure | null> {
  if (selfId && parentIssueId === selfId) return 'parent_invalid';
  const parent = await findIssue(db, parentIssueId);
  if (!parent || parent.teamId !== teamId) return 'parent_invalid';
  // Walk up: the issue must not be one of its own ancestors.
  if (selfId) {
    let cursor: string | null = parent.parentIssueId;
    for (let depth = 0; cursor && depth < 50; depth++) {
      if (cursor === selfId) return 'parent_invalid';
      const next = await findIssue(db, cursor);
      cursor = next?.parentIssueId ?? null;
    }
  }
  return null;
}

async function validateLabels(db: Db, teamId: string, labelIds: string[]): Promise<IssueRefFailure | null> {
  const unique = [...new Set(labelIds)];
  const found = await db
    .select({ id: mergeLabels.id })
    .from(mergeLabels)
    .where(
      and(
        inArray(mergeLabels.id, unique),
        isNull(mergeLabels.deletedAt),
        or(eq(mergeLabels.teamId, teamId), isNull(mergeLabels.teamId)),
      ),
    );
  return found.length === unique.length ? null : 'labels_invalid';
}

/** Cycle, parent and labels must belong to the issue's team (labels may also be workspace-wide). */
async function validateRefs(
  db: Db,
  teamId: string,
  refs: { cycleId?: string | null; parentIssueId?: string | null; labelIds?: string[]; selfId?: string },
): Promise<IssueRefFailure | null> {
  if (refs.cycleId) {
    const failure = await validateCycle(db, teamId, refs.cycleId);
    if (failure) return failure;
  }
  if (refs.parentIssueId) {
    const failure = await validateParent(db, teamId, refs.parentIssueId, refs.selfId);
    if (failure) return failure;
  }
  if (refs.labelIds && refs.labelIds.length > 0) return validateLabels(db, teamId, refs.labelIds);
  return null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type IssueCreateResult =
  | { ok: true; issue: MergeIssueRow; team: MergeTeamRow; links: MergeRecordLinkRow[] }
  | { ok: false; reason: 'team_not_found' | IssueRefFailure };

/**
 * One statement takes the team's next number and inserts the issue, so the
 * allocation and the row commit together on every driver (neon-http has no
 * interactive transactions): a failed insert hands no number out.
 */
export async function createIssue(db: Db, input: CreateMergeIssueInput, userId: string): Promise<IssueCreateResult> {
  const team = await findTeam(db, input.teamId);
  if (!team) return { ok: false, reason: 'team_not_found' };
  const labelIds = [...new Set(input.labelIds ?? [])];
  const refFailure = await validateRefs(db, team.id, {
    cycleId: input.cycleId,
    parentIssueId: input.parentIssueId,
    labelIds,
  });
  if (refFailure) return { ok: false, reason: refFailure };

  const now = new Date();
  const status = input.status ?? 'backlog';
  const stamps = statusTimestamps(status, { startedAt: null, completedAt: null, canceledAt: null }, now);
  const id = generateId('mis');
  const nowIso = now.toISOString();

  const inserted = executeRows<{ id: string }>(
    await db.execute(sql`
      with next as (
        update merge_teams
        set issue_counter = issue_counter + 1
        where id = ${team.id}::varchar and deleted_at is null
        returning issue_counter
      )
      insert into merge_issues (
        id, team_id, number, title, description, status, priority, assignee_user_id, creator_user_id,
        cycle_id, parent_issue_id, label_ids, estimate, due_date, flow_project_id, sort_order,
        started_at, completed_at, canceled_at, created_at, updated_at
      )
      select
        ${id}::varchar, ${team.id}::varchar, next.issue_counter, ${input.title.trim()}::varchar,
        ${input.description ?? null}::text, ${status}::varchar, ${input.priority ?? 0}::int,
        ${input.assigneeUserId ?? null}::varchar, ${userId}::varchar,
        ${input.cycleId ?? null}::varchar, ${input.parentIssueId ?? null}::varchar,
        ${JSON.stringify(labelIds)}::jsonb, ${input.estimate ?? null}::int, ${input.dueDate ?? null}::date,
        ${input.flowProjectId ?? null}::varchar, 0::double precision,
        ${iso(stamps.startedAt)}::timestamptz, ${iso(stamps.completedAt)}::timestamptz, ${iso(stamps.canceledAt)}::timestamptz,
        ${nowIso}::timestamptz, ${nowIso}::timestamptz
      from next
      returning id
    `),
  );
  if (inserted.length === 0) return { ok: false, reason: 'team_not_found' };
  const issue = await findIssue(db, id);
  const links = await insertRecordLinks(db, id, input.links ?? [], userId);
  return { ok: true, issue: issue!, team, links };
}

// ---------------------------------------------------------------------------
// Record links created with an issue (a desk agent escalating a ticket)
// ---------------------------------------------------------------------------

/** Links an issue to records elsewhere in WeldSuite; a repeated record is stored once. */
export async function insertRecordLinks(
  db: Db,
  issueId: string,
  links: CreateMergeRecordLinkInput[],
  userId: string | null,
): Promise<MergeRecordLinkRow[]> {
  if (links.length === 0) return [];
  // The first mention of a record wins (it may carry the title).
  const byRecord = new Map<string, CreateMergeRecordLinkInput>();
  for (const link of links) {
    const key = `${link.recordType}:${link.recordId}`;
    if (!byRecord.has(key)) byRecord.set(key, link);
  }
  const unique = [...byRecord.values()];
  const now = new Date();
  return db
    .insert(mergeRecordLinks)
    .values(
      unique.map((l) => ({
        id: generateId('mrk'),
        issueId,
        recordType: l.recordType,
        recordId: l.recordId,
        title: l.title?.trim() || null,
        createdByUserId: userId,
        createdAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning();
}

export async function listRecordLinks(db: Db, issueId: string): Promise<MergeRecordLinkRow[]> {
  return db
    .select()
    .from(mergeRecordLinks)
    .where(eq(mergeRecordLinks.issueId, issueId))
    .orderBy(asc(mergeRecordLinks.createdAt), asc(mergeRecordLinks.id));
}

export type IssueUpdateResult =
  | { ok: true; before: MergeIssueRow; issue: MergeIssueRow; teamKey: string }
  | { ok: false; reason: 'not_found' | IssueRefFailure };

function buildIssuePatch(
  input: UpdateMergeIssueInput,
  labelIds: string[] | undefined,
  before: MergeIssueRow,
  now: Date,
): Partial<typeof mergeIssues.$inferInsert> {
  const patch: Partial<typeof mergeIssues.$inferInsert> = { updatedAt: now };
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.assigneeUserId !== undefined) patch.assigneeUserId = input.assigneeUserId;
  if (input.cycleId !== undefined) patch.cycleId = input.cycleId;
  if (input.parentIssueId !== undefined) patch.parentIssueId = input.parentIssueId;
  if (labelIds !== undefined) patch.labelIds = labelIds;
  if (input.estimate !== undefined) patch.estimate = input.estimate;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (input.flowProjectId !== undefined) patch.flowProjectId = input.flowProjectId;
  if (input.agentId !== undefined) patch.agentId = input.agentId;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.status !== undefined && input.status !== before.status) {
    patch.status = input.status;
    Object.assign(patch, statusTimestamps(input.status, before, now));
  }
  return patch;
}

export async function updateIssue(db: Db, id: string, input: UpdateMergeIssueInput): Promise<IssueUpdateResult> {
  const before = await findIssue(db, id);
  if (!before) return { ok: false, reason: 'not_found' };

  const labelIds = input.labelIds ? [...new Set(input.labelIds)] : undefined;
  const refFailure = await validateRefs(db, before.teamId, {
    cycleId: input.cycleId,
    parentIssueId: input.parentIssueId,
    labelIds,
    selfId: id,
  });
  if (refFailure) return { ok: false, reason: refFailure };

  const now = new Date();
  const patch = buildIssuePatch(input, labelIds, before, now);

  const [issue] = await db.update(mergeIssues).set(patch).where(eq(mergeIssues.id, id)).returning();
  const [team] = await db.select({ key: mergeTeams.key }).from(mergeTeams).where(eq(mergeTeams.id, before.teamId)).limit(1);
  return { ok: true, before, issue: issue!, teamKey: team?.key ?? '' };
}

/**
 * Moves an issue to a status on behalf of a pull request's automation: an
 * ordinary issue update (timestamps included), made by the system actor.
 */
export async function moveIssueStatus(db: Db, issue: MergeIssueRow, status: MergeIssueRow['status']): Promise<MergeIssueRow> {
  const now = new Date();
  const [row] = await db
    .update(mergeIssues)
    .set({ status, ...statusTimestamps(status, issue, now), updatedAt: now })
    .where(eq(mergeIssues.id, issue.id))
    .returning();
  return row!;
}

/** Soft delete; sub-issues lose their parent. */
export async function deleteIssue(db: Db, id: string): Promise<{ issue: MergeIssueRow; teamKey: string } | null> {
  const existing = await findIssue(db, id);
  if (!existing) return null;
  const now = new Date();
  await db.update(mergeIssues).set({ parentIssueId: null, updatedAt: now }).where(eq(mergeIssues.parentIssueId, id));
  const [issue] = await db
    .update(mergeIssues)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(mergeIssues.id, id))
    .returning();
  const [team] = await db.select({ key: mergeTeams.key }).from(mergeTeams).where(eq(mergeTeams.id, existing.teamId)).limit(1);
  return { issue: issue!, teamKey: team?.key ?? '' };
}

export const ISSUE_CHANGE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'assigneeUserId',
  'cycleId',
  'parentIssueId',
  'labelIds',
  'estimate',
  'dueDate',
  'flowProjectId',
  'agentId',
] as const;
