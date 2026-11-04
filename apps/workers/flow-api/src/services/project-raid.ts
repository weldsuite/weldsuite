/**
 * RAID log queries and builders shared by `/api/project-raid` and
 * `/api/project-control-links` (design: weldflow-project-control.md).
 *
 * The rules themselves (scores, numbering, status sets, link rules) are in
 * `@weldsuite/flow-domain/raid` and `/risk`; this file is the database side:
 * progress counts, resolving the ends of a link, and the insert values of a
 * new item.
 */

import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  ControlLinkType,
  ConvertRaidItemInput,
  CreateRaidItemInput,
  LinkedObject,
} from '@weldsuite/app-api-client/schemas/project-control';
import {
  PROGRESS_RELATIONS,
  closedAtFor,
  initialRaidStatus,
  presentControlLink,
  raidCode,
  severityForBand,
  type LinkEnd,
} from '@weldsuite/flow-domain/raid';
import { nextReviewAt, riskBand, riskScore } from '@weldsuite/flow-domain/risk';
import { benefitCode } from '@weldsuite/flow-domain/benefits';
import { decisionCode } from '@weldsuite/flow-domain/decisions';
import { deliverableCode } from '@weldsuite/flow-domain/deliverables';

const items = schema.projectRaidItems;
const links = schema.projectControlLinks;

export type RaidItemRow = typeof items.$inferSelect;
export type NewRaidItemRow = typeof items.$inferInsert;
export type ControlLinkRow = typeof links.$inferSelect;

export interface TaskProgress {
  done: number;
  total: number;
}

/** A money amount as the numeric column stores it: two decimals. */
export function money(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(2);
}

/** An ISO timestamp from a request body, or null. */
export function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Whether a live (not soft-deleted) project exists. */
export async function liveProjectExists(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  return !!row;
}

/** A live register item by id. */
export async function findRaidItem(db: Database, id: string): Promise<RaidItemRow | null> {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), isNull(items.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Task progress of register items: the live, non-cancelled tasks linked to
 * each with `mitigates` or `resolves`, and how many of them are done. Computed
 * on read; an item with no linked task is `{ done: 0, total: 0 }`.
 */
export async function taskProgressFor(db: Database, itemIds: string[]): Promise<Map<string, TaskProgress>> {
  const progress = new Map<string, TaskProgress>(itemIds.map((id) => [id, { done: 0, total: 0 }]));
  if (itemIds.length === 0) return progress;
  const rows = await db
    .select({
      itemId: links.toId,
      total: sql<number>`count(*)`.mapWith(Number),
      done: sql<number>`count(*) filter (where ${schema.tasks.status} = 'done')`.mapWith(Number),
    })
    .from(links)
    .innerJoin(schema.tasks, eq(schema.tasks.id, links.fromId))
    .where(
      and(
        eq(links.toType, 'raid_item'),
        inArray(links.toId, itemIds),
        eq(links.fromType, 'task'),
        inArray(links.relation, [...PROGRESS_RELATIONS]),
        isNull(schema.tasks.deletedAt),
        ne(schema.tasks.status, 'cancelled'),
      ),
    )
    .groupBy(links.toId);
  for (const row of rows) progress.set(row.itemId, { done: row.done, total: row.total });
  return progress;
}

/** What the UI shows of the object at one end of a link, and where it lives. */
export interface ResolvedEnd extends LinkEnd {
  title: string;
  status: string;
  code: string | null;
  ownerId: string | null;
  dueDate: Date | null;
}

type EndLoader = (db: Database, ids: string[]) => Promise<ResolvedEnd[]>;

const loadRaidItemEnds: EndLoader = async (db, ids) => {
  const rows = await db
    .select()
    .from(items)
    .where(and(inArray(items.id, ids), isNull(items.deletedAt)));
  return rows.map((row) => ({
    type: 'raid_item',
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    status: row.status,
    code: raidCode(row.kind, row.number),
    ownerId: row.ownerId,
    dueDate: row.dueAt,
  }));
};

const loadTaskEnds: EndLoader = async (db, ids) => {
  const rows = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      title: schema.tasks.title,
      status: schema.tasks.status,
      assigneeId: schema.tasks.assigneeId,
      dueDate: schema.tasks.dueDate,
    })
    .from(schema.tasks)
    .where(and(inArray(schema.tasks.id, ids), isNull(schema.tasks.deletedAt)));
  const ends: ResolvedEnd[] = [];
  for (const row of rows) {
    if (!row.projectId) continue;
    ends.push({
      type: 'task',
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      status: row.status,
      code: null,
      ownerId: row.assigneeId,
      dueDate: row.dueDate,
    });
  }
  return ends;
};

const loadDecisionEnds: EndLoader = async (db, ids) => {
  const rows = await db
    .select()
    .from(schema.projectDecisions)
    .where(and(inArray(schema.projectDecisions.id, ids), isNull(schema.projectDecisions.deletedAt)));
  return rows.map((row) => ({
    type: 'decision',
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    code: decisionCode(row.number),
    ownerId: row.deciderId ?? row.decidedBy,
    dueDate: row.decisionDueAt,
  }));
};

const loadChangeRequestEnds: EndLoader = async (db, ids) => {
  const rows = await db
    .select()
    .from(schema.projectChangeRequests)
    .where(and(inArray(schema.projectChangeRequests.id, ids), isNull(schema.projectChangeRequests.deletedAt)));
  return rows.map((row) => ({
    type: 'change_request',
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    code: `CR-${row.number}`,
    ownerId: row.requestedBy,
    dueDate: null,
  }));
};

const loadDeliverableEnds: EndLoader = async (db, ids) => {
  const rows = await db
    .select()
    .from(schema.projectDeliverables)
    .where(and(inArray(schema.projectDeliverables.id, ids), isNull(schema.projectDeliverables.deletedAt)));
  return rows.map((row) => ({
    type: 'deliverable',
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    code: deliverableCode(row.number),
    ownerId: row.ownerId,
    dueDate: row.plannedEnd,
  }));
};

const loadBenefitEnds: EndLoader = async (db, ids) => {
  const rows = await db
    .select()
    .from(schema.projectBenefits)
    .where(and(inArray(schema.projectBenefits.id, ids), isNull(schema.projectBenefits.deletedAt)));
  return rows.map((row) => ({
    type: 'benefit',
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    code: benefitCode(row.number),
    ownerId: row.ownerId,
    dueDate: row.realiseBy,
  }));
};

const loadMilestoneEnds: EndLoader = async (db, ids) => {
  const rows = await db
    .select({
      id: schema.milestones.id,
      projectId: schema.milestones.projectId,
      name: schema.milestones.name,
      status: schema.milestones.status,
      ownerId: schema.milestones.ownerId,
      dueDate: schema.milestones.dueDate,
    })
    .from(schema.milestones)
    .where(and(inArray(schema.milestones.id, ids), isNull(schema.milestones.deletedAt)));
  return rows.map((row) => ({
    type: 'milestone',
    id: row.id,
    projectId: row.projectId,
    title: row.name,
    status: row.status,
    code: null,
    ownerId: row.ownerId,
    dueDate: row.dueDate,
  }));
};

const END_LOADERS: Record<ControlLinkType, EndLoader> = {
  raid_item: loadRaidItemEnds,
  task: loadTaskEnds,
  decision: loadDecisionEnds,
  change_request: loadChangeRequestEnds,
  deliverable: loadDeliverableEnds,
  benefit: loadBenefitEnds,
  milestone: loadMilestoneEnds,
};

/**
 * Look up objects of one type. A task without a project cannot be part of
 * project control, so it is treated like a missing one.
 */
async function resolveEnds(db: Database, type: ControlLinkType, ids: string[]): Promise<Map<string, ResolvedEnd>> {
  const out = new Map<string, ResolvedEnd>();
  if (ids.length === 0) return out;
  for (const end of await END_LOADERS[type](db, ids)) out.set(end.id, end);
  return out;
}

/** One live object by type and id, or null. */
export async function resolveEnd(db: Database, type: ControlLinkType, id: string): Promise<ResolvedEnd | null> {
  return (await resolveEnds(db, type, [id])).get(id) ?? null;
}

type Direction = 'outgoing' | 'incoming';

/** The object at the other end of a link, seen in the given direction. */
function otherEnd(row: ControlLinkRow, direction: Direction): { type: ControlLinkType; id: string } {
  return direction === 'outgoing' ? { type: row.toType, id: row.toId } : { type: row.fromType, id: row.fromId };
}

/** The other-end objects of some links, by `type:id`. */
async function loadOtherEnds(
  db: Database,
  rows: ControlLinkRow[],
  directionOf: (row: ControlLinkRow) => Direction,
): Promise<Map<string, ResolvedEnd>> {
  const wanted = new Map<ControlLinkType, Set<string>>();
  for (const row of rows) {
    const { type, id } = otherEnd(row, directionOf(row));
    wanted.set(type, (wanted.get(type) ?? new Set()).add(id));
  }
  const loaded = new Map<string, ResolvedEnd>();
  for (const [type, ids] of wanted) {
    for (const [id, end] of await resolveEnds(db, type, [...ids])) loaded.set(`${type}:${id}`, end);
  }
  return loaded;
}

function presentTarget(end: ResolvedEnd): LinkedObject['target'] {
  return {
    type: end.type,
    id: end.id,
    projectId: end.projectId,
    title: end.title,
    status: end.status,
    code: end.code,
    ownerId: end.ownerId,
    dueDate: end.dueDate ? end.dueDate.toISOString() : null,
  };
}

/**
 * Links as seen from one object: each with its direction and the object at the
 * other end. A link is left out when its other end no longer exists or sits in
 * a project the caller cannot read (a dependency may point at another
 * project's milestone: its title is not for everyone). Oldest link first.
 */
export async function presentLinkedObjects(
  db: Database,
  rows: ControlLinkRow[],
  directionOf: (row: ControlLinkRow) => Direction,
  canRead: (projectId: string) => Promise<boolean>,
): Promise<LinkedObject[]> {
  const ends = await loadOtherEnds(db, rows, directionOf);
  const readable = new Map<string, boolean>();
  const mayRead = async (projectId: string): Promise<boolean> => {
    if (!readable.has(projectId)) readable.set(projectId, await canRead(projectId));
    return readable.get(projectId) === true;
  };

  const out: LinkedObject[] = [];
  for (const row of [...rows].sort(byCreation)) {
    const direction = directionOf(row);
    const { type, id } = otherEnd(row, direction);
    const end = ends.get(`${type}:${id}`);
    if (!end || !(await mayRead(end.projectId))) continue;
    out.push({ ...presentControlLink(row), direction, target: presentTarget(end) });
  }
  return out;
}

function byCreation(a: ControlLinkRow, b: ControlLinkRow): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Every link that has the object at either end, oldest first. */
export async function linksOfObject(db: Database, type: ControlLinkType, id: string): Promise<ControlLinkRow[]> {
  return db
    .select()
    .from(links)
    .where(or(and(eq(links.fromType, type), eq(links.fromId, id)), and(eq(links.toType, type), eq(links.toId, id))))
    .orderBy(asc(links.createdAt), asc(links.id));
}

/** Every link that has the register item at either end, oldest first. */
export async function linksOfRaidItem(db: Database, itemId: string): Promise<ControlLinkRow[]> {
  return linksOfObject(db, 'raid_item', itemId);
}

/**
 * The insert values of a new item of any kind: the shared columns, the
 * columns of its own kind, and nothing else. The status defaults to the first
 * of the kind's set; a risk's review date defaults from its band.
 */
export function newRaidItemValues(
  input: CreateRaidItemInput,
  ctx: { id: string; number: number; userId: string; now: Date },
): NewRaidItemRow {
  const { id, number, userId, now } = ctx;
  const status = input.status ?? initialRaidStatus(input.kind);
  const base = {
    id,
    projectId: input.projectId,
    kind: input.kind,
    number,
    title: input.title,
    description: input.description ?? null,
    status,
    category: input.category ?? null,
    ownerId: input.ownerId ?? null,
    closedAt: closedAtFor(input.kind, status, null, now),
    customFields: input.customFields ?? null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  } as const;
  const dueAt = toDate(input.dueAt);

  switch (input.kind) {
    case 'risk':
      return {
        ...base,
        dueAt: dueAt ?? nextReviewAt(now, riskBand(riskScore(input.probability, input.impact)), input.reviewIntervalDays),
        probability: input.probability,
        impact: input.impact,
        residualProbability: input.residualProbability ?? null,
        residualImpact: input.residualImpact ?? null,
        strategy: input.strategy ?? null,
        trigger: input.trigger ?? null,
        costImpact: money(input.costImpact),
        scheduleImpactDays: input.scheduleImpactDays ?? null,
        reviewIntervalDays: input.reviewIntervalDays ?? null,
      };
    case 'assumption':
      return { ...base, dueAt, confidence: input.confidence ?? null, ifWrong: input.ifWrong ?? null };
    case 'issue':
      return { ...base, dueAt, severity: input.severity ?? 'medium', escalatedAt: toDate(input.escalatedAt) };
    case 'dependency':
      return {
        ...base,
        dueAt,
        direction: input.direction,
        partyType: input.partyType ?? null,
        partyProjectId: input.partyProjectId ?? null,
        partyName: input.partyName ?? null,
      };
  }
}

/**
 * The insert values of the item a conversion creates. It starts from the
 * source's title, description, category and owner unless the body overrides
 * them, and has no custom fields. A risk (from an assumption) takes the
 * ratings of the body and a review date from its band; an issue (from a risk)
 * takes the given severity, else the one of the risk's band.
 */
export function convertedItemValues(
  source: RaidItemRow,
  input: ConvertRaidItemInput,
  ctx: { id: string; number: number; userId: string; now: Date },
): NewRaidItemRow {
  const { id, number, userId, now } = ctx;
  const shared = {
    id,
    projectId: source.projectId,
    number,
    title: input.title ?? source.title,
    description: input.description !== undefined ? input.description : source.description,
    category: input.category !== undefined ? input.category : source.category,
    ownerId: input.ownerId !== undefined ? input.ownerId : source.ownerId,
    customFields: null,
    closedAt: null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  const dueAt = toDate(input.dueAt);
  if (input.to === 'risk' && input.probability !== undefined && input.impact !== undefined) {
    const band = riskBand(riskScore(input.probability, input.impact));
    return {
      ...shared,
      kind: 'risk',
      status: initialRaidStatus('risk'),
      probability: input.probability,
      impact: input.impact,
      dueAt: dueAt ?? nextReviewAt(now, band),
    };
  }
  const sourceBand =
    source.probability !== null && source.impact !== null ? riskBand(riskScore(source.probability, source.impact)) : 'medium';
  return {
    ...shared,
    kind: 'issue',
    status: initialRaidStatus('issue'),
    severity: input.severity ?? severityForBand(sourceBand),
    dueAt,
  };
}
