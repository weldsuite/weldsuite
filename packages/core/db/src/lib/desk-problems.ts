/**
 * WeldDesk problem management: a problem is the cause behind one or more
 * incidents (inbox conversations). The only writer of `desk_problems` and of
 * `desk_conversations.problem_id`; linking an incident also lands on its
 * timeline as an internal event (`problem_linked`, `problem_unlinked`)
 * through appendDeskMessage.
 *
 * Rules:
 *   - A conversation belongs to at most one problem. Replacing it appends
 *     `problem_unlinked` then `problem_linked`; linking what is already linked
 *     changes nothing.
 *   - A merged duplicate can't be linked (link the kept ticket), and a closed
 *     problem takes no new incidents.
 *   - Status moves the timestamps: `known_error` sets `knownErrorAt` (once),
 *     `resolved` sets `resolvedAt`, `closed` sets `closedAt` (and `resolvedAt`
 *     when it was never resolved); back to open / investigating clears all
 *     three, and from resolved / closed back to known_error clears the last
 *     two. A known error needs a workaround or a root cause.
 *   - Deleting a problem unlinks its incidents without timeline events.
 *
 * Callers publish the realtime and entity events for each change, in order.
 * The Rust twin is `weldsuite_desk_domain::problems`.
 */

import { and, asc, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { TenantDb } from './any-db';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';
import type { DeskConversation, DeskPriority } from '../schema/desk-conversations';
import {
  DESK_PROBLEM_OPEN_STATUSES,
  type DeskProblem,
  type DeskProblemStatus,
} from '../schema/desk-problems';
import type { DeskEventType, DeskMessageMetadata } from '../schema/desk-messages';
import { appendDeskMessage, DeskConversationNotFoundError, isUniqueViolation, likePattern } from './desk';
import {
  deskConversationLinkSummaryOf,
  MAX_DESK_CHILDREN,
  type DeskConversationLinkSummary,
  type DeskLinkChange,
} from './desk-links';

type AnyDb = TenantDb;

const problems = schema.deskProblems;
const conversations = schema.deskConversations;

/** Why a problem change was refused; routes answer 409 with `reason`. */
export type DeskProblemRefusal = 'merged' | 'problem_closed' | 'workaround_required';

export class DeskProblemRejectedError extends Error {
  constructor(
    readonly reason: DeskProblemRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'DeskProblemRejectedError';
  }
}

export class DeskProblemNotFoundError extends Error {
  constructor(readonly problemId: string) {
    super(`Problem '${problemId}' not found`);
    this.name = 'DeskProblemNotFoundError';
  }
}

/** A team or an owner that doesn't exist or is inactive; routes answer 400. */
export class DeskProblemFieldError extends Error {
  constructor(
    readonly field: 'departmentId' | 'assigneeId',
    message: string,
  ) {
    super(message);
    this.name = 'DeskProblemFieldError';
  }
}

export interface DeskProblemWithCounts extends DeskProblem {
  /** Every conversation linked to the problem. */
  incidentCount: number;
  /** The linked conversations that are open and not merged away. */
  openIncidentCount: number;
}

/** A problem as an incident's details panel shows it. */
export interface DeskProblemSummary {
  id: string;
  problemNumber: number;
  title: string;
  status: DeskProblemStatus;
  workaround: string | null;
  rootCause: string | null;
}

export function deskProblemSummaryOf(row: DeskProblem): DeskProblemSummary {
  return {
    id: row.id,
    problemNumber: row.problemNumber,
    title: row.title,
    status: row.status,
    workaround: row.workaround,
    rootCause: row.rootCause,
  };
}

interface EventInput {
  generateId: IdGenerator;
  authorId: string | null;
}

// ---------------------------------------------------------------------------
// Status rules (pure)
// ---------------------------------------------------------------------------

type StatusTimes = Pick<DeskProblem, 'knownErrorAt' | 'resolvedAt' | 'closedAt'>;

/**
 * The timestamps a move to `next` writes (only the keys that change). Nothing
 * for a move to the status the problem already has.
 */
export function deskProblemStatusPatch(
  current: Pick<DeskProblem, 'status'> & StatusTimes,
  next: DeskProblemStatus,
  now: Date,
): Partial<StatusTimes> {
  if (current.status === next) return {};
  switch (next) {
    case 'known_error':
      return { knownErrorAt: current.knownErrorAt ?? now, resolvedAt: null, closedAt: null };
    case 'resolved':
      return { resolvedAt: now, closedAt: null };
    case 'closed':
      return { closedAt: now, resolvedAt: current.resolvedAt ?? now };
    default:
      return { knownErrorAt: null, resolvedAt: null, closedAt: null };
  }
}

function blank(value: string | null | undefined): boolean {
  return !value || value.trim() === '';
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A problem logged as closed takes no incidents (the rule `assertLinkable`
 * applies to an existing one). Checked before the problem is written: the
 * link would otherwise fail after the insert and leave the problem behind.
 */
export function assertOpenForIncidents(status: DeskProblemStatus, incidents: number): void {
  if (status === 'closed' && incidents > 0) {
    throw new DeskProblemRejectedError(
      'problem_closed',
      'A closed problem takes no incidents; link the tickets before closing it',
    );
  }
}

function assertKnownErrorBacked(status: DeskProblemStatus, workaround: string | null, rootCause: string | null) {
  if (status === 'known_error' && blank(workaround) && blank(rootCause)) {
    throw new DeskProblemRejectedError(
      'workaround_required',
      'A known error needs a workaround or a root cause',
    );
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function assertTeam(db: AnyDb, departmentId: string): Promise<void> {
  const [team] = await db
    .select({ id: schema.helpdeskDepartments.id, isActive: schema.helpdeskDepartments.isActive, deletedAt: schema.helpdeskDepartments.deletedAt })
    .from(schema.helpdeskDepartments)
    .where(eq(schema.helpdeskDepartments.id, departmentId))
    .limit(1);
  if (!team || team.isActive === false || team.deletedAt) {
    throw new DeskProblemFieldError('departmentId', `Team '${departmentId}' does not exist or is inactive`);
  }
}

async function assertMember(db: AnyDb, userId: string): Promise<void> {
  const m = schema.workspaceMembers;
  const [member] = await db
    .select({ id: m.id })
    .from(m)
    .where(and(eq(m.userId, userId), isNull(m.deletedAt), sql`upper(${m.status}) = 'ACTIVE'`))
    .limit(1);
  if (!member) {
    throw new DeskProblemFieldError('assigneeId', `Member '${userId}' does not exist or is inactive`);
  }
}

async function assertOwnerAndTeam(
  db: AnyDb,
  input: { assigneeId?: string | null; departmentId?: string | null },
): Promise<void> {
  if (input.departmentId) await assertTeam(db, input.departmentId);
  if (input.assigneeId) await assertMember(db, input.assigneeId);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Written with the outer table spelled out: inside a single-table select
// drizzle drops the table qualifier, and `id` would then mean the incident's.
const incidentCount = sql<number>`(SELECT count(*)::int FROM desk_conversations ic WHERE ic.problem_id = "desk_problems"."id")`;
const openIncidentCount = sql<number>`(SELECT count(*)::int FROM desk_conversations ic WHERE ic.problem_id = "desk_problems"."id" AND ic.state = 'open' AND ic.merged_into_id IS NULL)`;

const withCounts = {
  ...getTableColumns(problems),
  incidentCount: incidentCount.as('incident_count'),
  openIncidentCount: openIncidentCount.as('open_incident_count'),
};

function counted(row: DeskProblemWithCounts): DeskProblemWithCounts {
  return { ...row, incidentCount: Number(row.incidentCount), openIncidentCount: Number(row.openIncidentCount) };
}

async function findProblem(db: AnyDb, id: string): Promise<DeskProblem | null> {
  const [row] = await db.select().from(problems).where(eq(problems.id, id)).limit(1);
  return row ?? null;
}

async function loadProblem(db: AnyDb, id: string): Promise<DeskProblem> {
  const row = await findProblem(db, id);
  if (!row) throw new DeskProblemNotFoundError(id);
  return row;
}

async function findConversation(db: AnyDb, id: string): Promise<DeskConversation | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return row ?? null;
}

/** One problem with its incident counts; null when it doesn't exist. */
export async function getDeskProblem(db: AnyDb, id: string): Promise<DeskProblemWithCounts | null> {
  const [row] = await db.select(withCounts).from(problems).where(eq(problems.id, id)).limit(1);
  return row ? counted(row) : null;
}

export interface ListDeskProblemsQuery {
  statuses?: DeskProblemStatus[];
  /** The known-error database: every problem that was ever a known error, resolved ones included. */
  knownErrors?: boolean;
  assigneeId?: string;
  departmentId?: string;
  /** Title, description, root cause, workaround, or `#number`. */
  q?: string;
  /** An offset, as the other desk lists use. */
  cursor?: string;
  limit?: number;
}

function problemFilters(query: ListDeskProblemsQuery): SQL[] {
  const filters: SQL[] = [];
  if (query.statuses && query.statuses.length > 0) filters.push(inArray(problems.status, query.statuses));
  if (query.knownErrors) filters.push(sql`${problems.knownErrorAt} IS NOT NULL`);
  if (query.assigneeId) filters.push(eq(problems.assigneeId, query.assigneeId));
  if (query.departmentId) filters.push(eq(problems.departmentId, query.departmentId));
  const term = query.q?.trim();
  if (term) {
    const pattern = likePattern(term);
    const parts: SQL[] = [
      sql`${problems.title} ILIKE ${pattern}`,
      sql`${problems.description} ILIKE ${pattern}`,
      sql`${problems.rootCause} ILIKE ${pattern}`,
      sql`${problems.workaround} ILIKE ${pattern}`,
    ];
    const number = /^#?(\d{1,9})$/.exec(term);
    if (number) parts.push(eq(problems.problemNumber, Number(number[1])));
    const search = or(...parts);
    if (search) filters.push(search);
  }
  return filters;
}

/** Problems that still need work first, then the most recently touched. */
export async function listDeskProblems(
  db: AnyDb,
  query: ListDeskProblemsQuery = {},
): Promise<{ data: DeskProblemWithCounts[]; totalCount: number; hasMore: boolean; cursor: string | null }> {
  const limit = Math.min(query.limit ?? 30, 100);
  const filters = problemFilters(query);
  const where = filters.length > 0 ? and(...filters) : undefined;
  const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;

  const [total] = await db.select({ count: sql<number>`count(*)` }).from(problems).where(where);
  const open = sql.join(
    DESK_PROBLEM_OPEN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const rows = await db
    .select(withCounts)
    .from(problems)
    .where(where)
    .orderBy(sql`CASE WHEN ${problems.status} IN (${open}) THEN 0 ELSE 1 END`, sql`${problems.updatedAt} DESC`, sql`${problems.id} DESC`)
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: page.map(counted),
    totalCount: Number(total?.count ?? 0),
    hasMore,
    cursor: hasMore ? String(offset + limit) : null,
  };
}

/** A problem's incidents by number, as link summaries. */
export async function listDeskProblemConversations(
  db: AnyDb,
  problemId: string,
  options: { limit?: number } = {},
): Promise<DeskConversationLinkSummary[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.problemId, problemId))
    .orderBy(asc(conversations.conversationNumber), asc(conversations.id))
    .limit(Math.min(options.limit ?? 100, 500));
  return rows.map(deskConversationLinkSummaryOf);
}

/** The problem a conversation is linked to; null when it has none. */
export async function getDeskConversationProblem(
  db: AnyDb,
  conversationId: string,
): Promise<DeskProblemSummary | null> {
  const [row] = await db
    .select({ problem: problems })
    .from(conversations)
    .innerJoin(problems, eq(problems.id, conversations.problemId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ? deskProblemSummaryOf(row.problem) : null;
}

// ---------------------------------------------------------------------------
// Linking incidents
// ---------------------------------------------------------------------------

async function problemEvent(
  db: AnyDb,
  input: EventInput,
  conversationId: string,
  eventType: DeskEventType,
  problem: Pick<DeskProblem, 'id' | 'problemNumber' | 'title'> | { id: string; problemNumber: null; title: null },
): Promise<DeskLinkChange> {
  const metadata: DeskMessageMetadata = {
    eventType,
    problemId: problem.id,
    problemNumber: problem.problemNumber,
    problemTitle: problem.title,
  };
  return appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId,
    kind: 'event',
    authorType: 'agent',
    authorId: input.authorId,
    metadata,
  });
}

export interface SetDeskConversationProblemInput extends EventInput {
  conversationId: string;
  /** The problem to link; null unlinks. */
  problemId: string | null;
}

export interface DeskConversationProblemResult {
  /** The conversation as it stands now. */
  conversation: DeskConversation;
  /** The linked problem after the change; null when the conversation has none. */
  problem: DeskProblemSummary | null;
  /** Every timeline entry written, in order (empty when nothing changed). */
  changes: DeskLinkChange[];
}

async function writeProblemId(db: AnyDb, conversationId: string, problemId: string | null): Promise<void> {
  await db.update(conversations).set({ problemId, updatedAt: new Date() }).where(eq(conversations.id, conversationId));
}

function assertLinkable(conversation: DeskConversation, problem: DeskProblem): void {
  if (conversation.mergedIntoId) {
    throw new DeskProblemRejectedError('merged', 'This ticket was merged into another one; link the kept ticket');
  }
  if (problem.status === 'closed') {
    throw new DeskProblemRejectedError(
      'problem_closed',
      `Problem #${problem.problemNumber} is closed and takes no new incidents`,
    );
  }
}

/**
 * Link a conversation to a problem, replace its problem, or unlink it
 * (`problemId: null`). No events when nothing changes.
 */
export async function setDeskConversationProblem(
  db: AnyDb,
  input: SetDeskConversationProblemInput,
): Promise<DeskConversationProblemResult> {
  const conversation = await findConversation(db, input.conversationId);
  if (!conversation) throw new DeskConversationNotFoundError(input.conversationId);
  const previousId = conversation.problemId;
  const previous = previousId ? await findProblem(db, previousId) : null;

  if (input.problemId === previousId) {
    return { conversation, problem: previous ? deskProblemSummaryOf(previous) : null, changes: [] };
  }

  const next = input.problemId ? await loadProblem(db, input.problemId) : null;
  if (next) assertLinkable(conversation, next);

  await writeProblemId(db, conversation.id, next?.id ?? null);
  const changes: DeskLinkChange[] = [];
  if (previousId) {
    changes.push(
      await problemEvent(db, input, conversation.id, 'problem_unlinked', previous ?? { id: previousId, problemNumber: null, title: null }),
    );
  }
  if (next) changes.push(await problemEvent(db, input, conversation.id, 'problem_linked', next));
  const last = changes.at(-1);
  return {
    conversation: last?.conversation ?? conversation,
    problem: next ? deskProblemSummaryOf(next) : null,
    changes,
  };
}

// ---------------------------------------------------------------------------
// Writing problems
// ---------------------------------------------------------------------------

export interface CreateDeskProblemInput {
  generateId: IdGenerator;
  authorId: string | null;
  title: string;
  description?: string | null;
  priority?: DeskPriority | null;
  assigneeId?: string | null;
  departmentId?: string | null;
  rootCause?: string | null;
  workaround?: string | null;
  status?: DeskProblemStatus;
  /** Incidents to link at creation. */
  conversationIds?: string[];
}

export interface CreateDeskProblemResult {
  problem: DeskProblemWithCounts;
  /** One `problem_linked` entry per conversation linked at creation. */
  changes: DeskLinkChange[];
}

async function nextProblemNumber(db: AnyDb): Promise<number> {
  const result = await db.execute<{ next: number }>(
    sql`SELECT COALESCE(MAX(${problems.problemNumber}), 0) + 1 AS next FROM ${problems}`,
  );
  const rows =
    (result as unknown as { rows?: Array<{ next: number }> }).rows ??
    (result as unknown as Array<{ next: number }>);
  return Number(rows?.[0]?.next ?? 1);
}

export async function createDeskProblem(db: AnyDb, input: CreateDeskProblemInput): Promise<CreateDeskProblemResult> {
  const status = input.status ?? 'open';
  const workaround = textOrNull(input.workaround);
  const rootCause = textOrNull(input.rootCause);
  assertKnownErrorBacked(status, workaround, rootCause);
  await assertOwnerAndTeam(db, input);

  // Check every incident before anything is written.
  const conversationIds = Array.from(new Set(input.conversationIds ?? []));
  for (const id of conversationIds) {
    const found = await findConversation(db, id);
    if (!found) throw new DeskConversationNotFoundError(id);
    if (found.mergedIntoId) {
      throw new DeskProblemRejectedError('merged', `Ticket #${found.conversationNumber} was merged into another one; link the kept ticket`);
    }
  }
  // The last refusal the links below can raise: with it, a 4xx never leaves a problem behind.
  assertOpenForIncidents(status, conversationIds.length);

  const id = input.generateId('dprob');
  const now = new Date();
  const times = deskProblemStatusPatch(
    { status: 'open', knownErrorAt: null, resolvedAt: null, closedAt: null },
    status,
    now,
  );

  // problem_number is MAX+1 under a unique index: retry with a fresh number
  // when two problems are logged in the same instant.
  for (let attempt = 0; ; attempt++) {
    const problemNumber = await nextProblemNumber(db);
    try {
      await db.insert(problems).values({
        id,
        createdAt: now,
        updatedAt: now,
        problemNumber,
        title: input.title.trim(),
        description: textOrNull(input.description),
        status,
        priority: input.priority ?? null,
        rootCause,
        workaround,
        assigneeId: input.assigneeId ?? null,
        departmentId: input.departmentId ?? null,
        createdById: input.authorId,
        knownErrorAt: times.knownErrorAt ?? null,
        resolvedAt: times.resolvedAt ?? null,
        closedAt: times.closedAt ?? null,
      });
      break;
    } catch (err) {
      if (attempt >= 4 || !isUniqueViolation(err)) throw err;
    }
  }

  const changes: DeskLinkChange[] = [];
  for (const conversationId of conversationIds) {
    const linked = await setDeskConversationProblem(db, {
      generateId: input.generateId,
      authorId: input.authorId,
      conversationId,
      problemId: id,
    });
    changes.push(...linked.changes);
  }
  const created = await getDeskProblem(db, id);
  if (!created) throw new DeskProblemNotFoundError(id);
  return { problem: created, changes };
}

export interface DeskProblemPatch {
  title?: string;
  description?: string | null;
  status?: DeskProblemStatus;
  priority?: DeskPriority | null;
  assigneeId?: string | null;
  departmentId?: string | null;
  rootCause?: string | null;
  workaround?: string | null;
  resolution?: string | null;
}

export interface UpdateDeskProblemInput {
  id: string;
  authorId: string | null;
  patch: DeskProblemPatch;
}

export interface DeskProblemFieldChange {
  from: unknown;
  to: unknown;
}

export interface UpdateDeskProblemResult {
  problem: DeskProblemWithCounts;
  /** The fields that changed (including the status timestamps), with their old and new value. */
  changes: Record<string, DeskProblemFieldChange>;
}

const TEXT_FIELDS = ['description', 'rootCause', 'workaround', 'resolution'] as const;

/** The columns a patch sets, in the order its fields are read; a new status brings its timestamps. */
function patchedColumns(current: DeskProblem, patch: DeskProblemPatch): Partial<DeskProblem> {
  const next: Partial<DeskProblem> = {};

  if (patch.title !== undefined) next.title = patch.title.trim();
  for (const field of TEXT_FIELDS) {
    if (patch[field] !== undefined) next[field] = textOrNull(patch[field]);
  }
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.assigneeId !== undefined) next.assigneeId = patch.assigneeId;
  if (patch.departmentId !== undefined) next.departmentId = patch.departmentId;

  if (patch.status !== undefined) {
    next.status = patch.status;
    Object.assign(next, deskProblemStatusPatch(current, patch.status, new Date()));
  }
  return next;
}

/** The columns whose new value differs from the stored one, with both; two dates at the same instant are the same. */
function changedFields(current: DeskProblem, next: Partial<DeskProblem>): Record<string, DeskProblemFieldChange> {
  const changes: Record<string, DeskProblemFieldChange> = {};
  for (const [key, value] of Object.entries(next) as Array<[keyof DeskProblem, unknown]>) {
    const before = current[key];
    const same = before instanceof Date && value instanceof Date ? before.getTime() === value.getTime() : before === value;
    if (!same) changes[key] = { from: before, to: value };
  }
  return changes;
}

export async function updateDeskProblem(db: AnyDb, input: UpdateDeskProblemInput): Promise<UpdateDeskProblemResult> {
  const current = await loadProblem(db, input.id);
  const { patch } = input;
  const next = patchedColumns(current, patch);

  const status = patch.status ?? current.status;
  assertKnownErrorBacked(
    status,
    next.workaround === undefined ? current.workaround : next.workaround,
    next.rootCause === undefined ? current.rootCause : next.rootCause,
  );
  await assertOwnerAndTeam(db, {
    assigneeId: next.assigneeId === current.assigneeId ? undefined : next.assigneeId,
    departmentId: next.departmentId === current.departmentId ? undefined : next.departmentId,
  });

  const changes = changedFields(current, next);

  if (Object.keys(changes).length === 0) {
    const unchanged = await getDeskProblem(db, current.id);
    if (!unchanged) throw new DeskProblemNotFoundError(current.id);
    return { problem: unchanged, changes };
  }

  await db.update(problems).set({ ...next, updatedAt: new Date() }).where(eq(problems.id, current.id));
  const updated = await getDeskProblem(db, current.id);
  if (!updated) throw new DeskProblemNotFoundError(current.id);
  return { problem: updated, changes };
}

/** Link the help-center article written from this problem. */
export async function setDeskProblemArticle(db: AnyDb, id: string, articleId: string | null): Promise<DeskProblemWithCounts> {
  await loadProblem(db, id);
  await db.update(problems).set({ articleId, updatedAt: new Date() }).where(eq(problems.id, id));
  const updated = await getDeskProblem(db, id);
  if (!updated) throw new DeskProblemNotFoundError(id);
  return updated;
}

/** Delete a problem; its incidents are unlinked quietly. Returns how many were unlinked. */
export async function deleteDeskProblem(db: AnyDb, id: string): Promise<{ problem: DeskProblem; unlinked: number }> {
  const problem = await loadProblem(db, id);
  const unlinked = await db
    .update(conversations)
    .set({ problemId: null })
    .where(eq(conversations.problemId, id))
    .returning({ id: conversations.id });
  await db.delete(problems).where(eq(problems.id, id));
  return { problem, unlinked: unlinked.length };
}

// ---------------------------------------------------------------------------
// Sharing the workaround
// ---------------------------------------------------------------------------

export interface ShareDeskProblemWorkaroundInput extends EventInput {
  problemId: string;
  /** What to post; the problem's workaround when absent. */
  body?: string | null;
  /** `note`: internal note on each ticket; `reply`: an agent reply the customer gets. */
  visibility: 'note' | 'reply';
}

export interface ShareDeskProblemWorkaroundResult {
  problem: DeskProblem;
  /** One entry per open incident, by number. */
  changes: DeskLinkChange[];
  /** Open incidents past the cap that got nothing. */
  skipped: number;
}

/**
 * "Share workaround with linked tickets": one note or reply on each open
 * incident (open, not merged away), with `metadata.problemId`. The caller
 * delivers each reply on its conversation's channel.
 */
export async function shareDeskProblemWorkaround(
  db: AnyDb,
  input: ShareDeskProblemWorkaroundInput,
): Promise<ShareDeskProblemWorkaroundResult> {
  const problem = await loadProblem(db, input.problemId);
  const text = textOrNull(input.body) ?? textOrNull(problem.workaround);
  if (!text) {
    throw new DeskProblemRejectedError('workaround_required', 'Write the workaround first, there is nothing to share');
  }
  const open = and(eq(conversations.problemId, problem.id), eq(conversations.state, 'open'), isNull(conversations.mergedIntoId));
  const targets = await db
    .select()
    .from(conversations)
    .where(open)
    .orderBy(asc(conversations.conversationNumber), asc(conversations.id))
    .limit(MAX_DESK_CHILDREN);
  const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(conversations).where(open);

  const changes: DeskLinkChange[] = [];
  for (const target of targets) {
    changes.push(
      await appendDeskMessage(db, {
        generateId: input.generateId,
        conversationId: target.id,
        kind: input.visibility === 'note' ? 'note' : 'message',
        authorType: 'agent',
        authorId: input.authorId,
        body: text,
        metadata: { problemId: problem.id },
      }),
    );
  }
  return { problem, changes, skipped: Math.max(0, Number(total?.count ?? 0) - targets.length) };
}

// ---------------------------------------------------------------------------
// Article from a problem
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function section(heading: string, body: string | null): string {
  const text = body?.trim();
  if (!text) return '';
  const html = escapeHtml(text.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
  return `<h2>${escapeHtml(heading)}</h2><p>${html}</p>`;
}

/** The article editor's HTML for a known error: symptoms, cause and workaround. */
export function deskArticleDraftFromProblem(
  problem: Pick<DeskProblem, 'title' | 'description' | 'rootCause' | 'workaround'>,
  headings: { symptoms: string; cause: string; workaround: string } = {
    symptoms: 'Symptoms',
    cause: 'Cause',
    workaround: 'Workaround',
  },
): { title: string; content: string; excerpt: string | null } {
  const title = Array.from(problem.title.trim()).slice(0, 200).join('');
  const content =
    section(headings.symptoms, problem.description) +
    section(headings.cause, problem.rootCause) +
    section(headings.workaround, problem.workaround);
  const lead = (problem.workaround ?? problem.description)?.replace(/[\r\n\t ]+/g, ' ').trim();
  return { title, content: content || '<p></p>', excerpt: lead ? Array.from(lead).slice(0, 200).join('') : null };
}
