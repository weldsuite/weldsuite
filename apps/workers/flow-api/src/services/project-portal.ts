/**
 * Queries behind the client portal (`/public/project-portal`, FLOW-020).
 *
 * Every function here starts from the contact's own access: the projects where
 * one of their CRM contacts is a stakeholder with `portal_access`, on a live
 * project. Nothing is read for a project outside that set, and every list of
 * shared items filters on `client_visible` in SQL, so a row the team did not
 * share never leaves the database.
 */

import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { compareReviews, listPendingForApprover, type PendingReview } from '@weldsuite/flow-domain/approvals';
import {
  isPortalApprovalSubject,
  nextMilestoneOf,
  presentApproval,
  presentChangeRequest,
  presentDeliverable,
  presentDocument,
  presentFile,
  presentMessage,
  presentMilestone,
  presentReport,
  progressPercent,
  type PortalMilestoneRow,
} from '@weldsuite/flow-domain/project-portal';
import type {
  PortalApproval,
  PortalDocument,
  PortalFile,
  PortalMessage,
  PortalProject,
  PortalProjectSummary,
  PortalReport,
} from '@weldsuite/app-api-client/schemas/project-portal';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const people = schema.people;
const stakeholders = schema.projectStakeholders;
const projects = schema.projects;
const milestones = schema.milestones;
const approvals = schema.flowApprovals;
const deliverables = schema.projectDeliverables;
const changes = schema.projectChangeRequests;
const reports = schema.projectStatusReports;
const projectFiles = schema.projectFiles;
const driveFiles = schema.files;
const messages = schema.projectMessages;
const members = schema.workspaceMembers;

// ── Who may sign in, and where ──────────────────────────────────────────────

export interface PortalContactRow {
  id: string;
  name: string;
  email: string | null;
}

/**
 * The CRM contacts with this address that are a stakeholder with portal access
 * on at least one live project. A duplicate contact (same address) is a second
 * row, so both keep their own projects.
 */
export async function contactsWithAccess(db: Database, email: string): Promise<PortalContactRow[]> {
  return db
    .selectDistinct({ id: people.id, name: people.displayName, email: people.email })
    .from(people)
    .innerJoin(stakeholders, eq(stakeholders.crmContactId, people.id))
    .innerJoin(projects, eq(projects.id, stakeholders.projectId))
    .where(
      and(
        sql`lower(${people.email}) = ${email}`,
        isNull(people.deletedAt),
        eq(stakeholders.portalAccess, true),
        isNull(stakeholders.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(people.id));
}

/** The contacts of a session, by id, in id order. */
export async function contactsOfSession(db: Database, contactIds: readonly string[]): Promise<PortalContactRow[]> {
  if (contactIds.length === 0) return [];
  return db
    .select({ id: people.id, name: people.displayName, email: people.email })
    .from(people)
    .where(and(inArray(people.id, [...contactIds]), isNull(people.deletedAt)))
    .orderBy(asc(people.id));
}

export interface PortalProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  progress: string;
  startDate: Date | null;
  endDate: Date | null;
  projectManagerId: string | null;
  currency: string | null;
  updatedAt: Date;
  /** The contact of the session that is the stakeholder on this project. */
  contactId: string;
}

/**
 * The projects the contacts may see: stakeholder with `portal_access` on a live
 * project, for a live contact. Read on every request, which is what makes a
 * revoked `portal_access` take effect at once.
 */
export async function portalProjectRows(db: Database, contactIds: readonly string[]): Promise<PortalProjectRow[]> {
  if (contactIds.length === 0) return [];
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      progress: projects.progress,
      startDate: projects.startDate,
      endDate: projects.endDate,
      projectManagerId: projects.projectManagerId,
      currency: projects.budgetCurrency,
      updatedAt: projects.updatedAt,
      contactId: stakeholders.crmContactId,
    })
    .from(stakeholders)
    .innerJoin(projects, eq(projects.id, stakeholders.projectId))
    .innerJoin(people, eq(people.id, stakeholders.crmContactId))
    .where(
      and(
        inArray(stakeholders.crmContactId, [...contactIds]),
        eq(stakeholders.portalAccess, true),
        isNull(stakeholders.deletedAt),
        isNull(projects.deletedAt),
        isNull(people.deletedAt),
      ),
    )
    .orderBy(asc(projects.name), asc(projects.id), asc(stakeholders.crmContactId));
  // A project the contacts hold twice (a duplicate contact) counts once, for the first contact.
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (seen.has(row.id) || !row.contactId) return [];
    seen.add(row.id);
    return [{ ...row, contactId: row.contactId }];
  });
}

/** Member user ids to names: only the name, never an email. */
export async function memberNames(db: Database, userIds: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = await db.select({ userId: members.userId, name: members.name }).from(members).where(inArray(members.userId, ids));
  for (const row of rows) if (row.name?.trim()) names.set(row.userId, row.name);
  return names;
}

// ── Approvals ───────────────────────────────────────────────────────────────

/**
 * The reviews addressed to these contacts that wait for them: pending, whose
 * earlier steps are answered, about a deliverable or a change request, on a
 * project the contacts may see. Earliest due date first.
 */
export async function pendingReviews(
  db: Database,
  contactIds: readonly string[],
  projectIds: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<PendingReview[]> {
  const lists = await Promise.all(
    contactIds.map((contactId) => listPendingForApprover(db, contactId, { approverKind: 'contact', now })),
  );
  const seen = new Set<string>();
  return lists
    .flat()
    .filter(({ approval }) => {
      if (seen.has(approval.id)) return false;
      seen.add(approval.id);
      return !!approval.projectId && projectIds.has(approval.projectId) && isPortalApprovalSubject(approval.subjectType);
    })
    .sort((a, b) => compareReviews(a.approval, b.approval));
}

/** The reviews as the portal presents them, with their deliverable or change request. */
export async function presentReviews(
  db: Database,
  reviews: readonly PendingReview[],
  projectsById: ReadonlyMap<string, PortalProjectRow>,
): Promise<PortalApproval[]> {
  if (reviews.length === 0) return [];
  const deliverableIds = reviews.filter((r) => r.approval.subjectType === 'deliverable').map((r) => r.approval.subjectId);
  const changeIds = reviews.filter((r) => r.approval.subjectType === 'change_request').map((r) => r.approval.subjectId);
  const [deliverableRows, changeRows, names] = await Promise.all([
    deliverableIds.length
      ? db.select().from(deliverables).where(and(inArray(deliverables.id, deliverableIds), isNull(deliverables.deletedAt)))
      : Promise.resolve([]),
    changeIds.length
      ? db.select().from(changes).where(and(inArray(changes.id, changeIds), isNull(changes.deletedAt)))
      : Promise.resolve([]),
    memberNames(db, reviews.map((r) => r.approval.createdBy)),
  ]);
  const deliverableById = new Map(deliverableRows.map((row) => [row.id, row]));
  const changeById = new Map(changeRows.map((row) => [row.id, row]));

  return reviews.flatMap(({ approval, actionable }) => {
    const project = approval.projectId ? projectsById.get(approval.projectId) : undefined;
    if (!project) return [];
    const presented = presentApproval({
      approval,
      projectName: project.name,
      currency: project.currency,
      requestedByName: names.get(approval.createdBy) ?? null,
      actionable,
      deliverable: deliverableById.get(approval.subjectId) ?? null,
      change: changeById.get(approval.subjectId) ?? null,
    });
    return presented ? [presented] : [];
  });
}

// ── Projects ────────────────────────────────────────────────────────────────

async function milestonesOf(db: Database, projectIds: readonly string[]): Promise<Map<string, PortalMilestoneRow[]>> {
  const byProject = new Map<string, PortalMilestoneRow[]>();
  if (projectIds.length === 0) return byProject;
  const rows = await db
    .select({
      id: milestones.id,
      projectId: milestones.projectId,
      name: milestones.name,
      description: milestones.description,
      dueDate: milestones.dueDate,
      status: milestones.status,
    })
    .from(milestones)
    .where(and(inArray(milestones.projectId, [...projectIds]), isNull(milestones.deletedAt)))
    .orderBy(asc(milestones.dueDate), asc(milestones.id));
  for (const row of rows) {
    const list = byProject.get(row.projectId);
    if (list) list.push(row);
    else byProject.set(row.projectId, [row]);
  }
  return byProject;
}

function summaryOf(
  row: PortalProjectRow,
  milestoneRows: readonly PortalMilestoneRow[],
  managerName: string | null,
  waitingForYou: number,
): PortalProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    progress: progressPercent(row.progress),
    startDate: row.startDate ? row.startDate.toISOString() : null,
    goLive: row.endDate ? row.endDate.toISOString() : null,
    projectManagerName: managerName,
    nextMilestone: nextMilestoneOf(milestoneRows),
    waitingForYou,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function waitingByProject(reviews: readonly PendingReview[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { approval } of reviews) {
    if (approval.projectId) counts.set(approval.projectId, (counts.get(approval.projectId) ?? 0) + 1);
  }
  return counts;
}

/** The contact's projects, with their next milestone and what waits for them. */
export async function listPortalProjects(
  db: Database,
  rows: readonly PortalProjectRow[],
  contactIds: readonly string[],
  now: Date = new Date(),
): Promise<PortalProjectSummary[]> {
  if (rows.length === 0) return [];
  const projectIds = new Set(rows.map((row) => row.id));
  const [milestoneMap, names, reviews] = await Promise.all([
    milestonesOf(db, [...projectIds]),
    memberNames(db, rows.map((row) => row.projectManagerId)),
    pendingReviews(db, contactIds, projectIds, now),
  ]);
  const waiting = waitingByProject(reviews);
  return rows.map((row) =>
    summaryOf(
      row,
      milestoneMap.get(row.id) ?? [],
      row.projectManagerId ? (names.get(row.projectManagerId) ?? null) : null,
      waiting.get(row.id) ?? 0,
    ),
  );
}

/** One project with its milestones, shared deliverables and changes, and the latest shared report. */
export async function getPortalProject(
  db: Database,
  row: PortalProjectRow,
  contactIds: readonly string[],
  now: Date = new Date(),
): Promise<PortalProject> {
  const projectIds = new Set([row.id]);
  const [milestoneMap, names, reviews, deliverableRows, changeRows, latest] = await Promise.all([
    milestonesOf(db, [row.id]),
    memberNames(db, [row.projectManagerId]),
    pendingReviews(db, contactIds, projectIds, now),
    db
      .select()
      .from(deliverables)
      .where(and(eq(deliverables.projectId, row.id), eq(deliverables.clientVisible, true), isNull(deliverables.deletedAt)))
      .orderBy(asc(deliverables.number)),
    db
      .select()
      .from(changes)
      .where(and(eq(changes.projectId, row.id), eq(changes.clientVisible, true), isNull(changes.deletedAt)))
      .orderBy(asc(changes.number)),
    listPortalReports(db, row.id, { limit: 1 }),
  ]);
  const milestoneRows = milestoneMap.get(row.id) ?? [];
  const summary = summaryOf(
    row,
    milestoneRows,
    row.projectManagerId ? (names.get(row.projectManagerId) ?? null) : null,
    reviews.length,
  );
  return {
    ...summary,
    milestones: milestoneRows.map(presentMilestone),
    deliverables: deliverableRows.map(presentDeliverable),
    changeRequests: changeRows.map((change) => presentChangeRequest(change, row.currency)),
    latestReport: latest.items[0] ?? null,
  };
}

// ── Paged lists of shared items ─────────────────────────────────────────────

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  cursor: string | null;
  totalCount: number;
}

interface PageOptions {
  limit: number;
  cursor?: string;
}

function page<Row extends { id: string }, T>(rows: Row[], limit: number, totalCount: number, present: (row: Row) => T): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: data.map(present),
    hasMore,
    cursor: hasMore && data.length > 0 ? data[data.length - 1]!.id : null,
    totalCount,
  };
}

/** Published, client visible reports of a project, newest first. A report a published, shared correction supersedes is left out. */
export async function listPortalReports(db: Database, projectId: string, options: PageOptions): Promise<Page<PortalReport>> {
  const base = and(
    eq(reports.projectId, projectId),
    eq(reports.status, 'published'),
    eq(reports.clientVisible, true),
    isNull(reports.deletedAt),
    sql`not exists (
      select 1 from ${reports} s
      where s.supersedes_id = ${reports.id} and s.status = 'published' and s.client_visible and s.deleted_at is null
    )`,
  );
  const conditions: SQL[] = [base as SQL];
  if (options.cursor) {
    const [cur] = await db
      .select({ publishedAt: reports.publishedAt, id: reports.id })
      .from(reports)
      .where(eq(reports.id, options.cursor))
      .limit(1);
    if (cur?.publishedAt) {
      conditions.push(
        sql`(${reports.publishedAt} < ${cur.publishedAt} or (${reports.publishedAt} = ${cur.publishedAt} and ${reports.id} < ${cur.id}))`,
      );
    }
  }
  const [rows, count] = await Promise.all([
    db
      .select()
      .from(reports)
      .where(and(...conditions))
      .orderBy(desc(reports.publishedAt), desc(reports.id))
      .limit(options.limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(reports).where(base),
  ]);
  const names = await memberNames(db, rows.map((row) => row.publishedBy));
  return page(rows, options.limit, Number(count[0]?.count ?? 0), (row) =>
    presentReport(row, row.publishedBy ? (names.get(row.publishedBy) ?? null) : null),
  );
}

/** Files of a project marked client visible (folders are not files here), newest first. */
export async function listPortalFiles(db: Database, projectId: string, options: PageOptions): Promise<Page<PortalFile>> {
  const base = and(
    eq(projectFiles.projectId, projectId),
    eq(projectFiles.clientVisible, true),
    eq(projectFiles.isFolder, false),
    isNull(projectFiles.deletedAt),
  ) as SQL;
  const conditions: SQL[] = [base];
  if (options.cursor) {
    const [cur] = await db
      .select({ createdAt: projectFiles.createdAt, id: projectFiles.id })
      .from(projectFiles)
      .where(eq(projectFiles.id, options.cursor))
      .limit(1);
    if (cur) {
      conditions.push(
        sql`(${projectFiles.createdAt} < ${cur.createdAt} or (${projectFiles.createdAt} = ${cur.createdAt} and ${projectFiles.id} < ${cur.id}))`,
      );
    }
  }
  const [rows, count] = await Promise.all([
    db
      .select()
      .from(projectFiles)
      .where(and(...conditions))
      .orderBy(desc(projectFiles.createdAt), desc(projectFiles.id))
      .limit(options.limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(projectFiles).where(base),
  ]);
  const names = await memberNames(db, rows.map((row) => row.uploadedById));
  return page(rows, options.limit, Number(count[0]?.count ?? 0), (row) => presentFile(row, names));
}

/** One shared file of a project, for its download. */
export async function findPortalFile(db: Database, projectId: string, fileId: string) {
  const [row] = await db
    .select()
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.clientVisible, true),
        eq(projectFiles.isFolder, false),
        isNull(projectFiles.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

const documentFilter = (projectId: string): SQL =>
  and(
    eq(driveFiles.entityType, 'project'),
    eq(driveFiles.entityId, projectId),
    eq(driveFiles.fileType, 'document'),
    eq(driveFiles.clientVisible, true),
    isNull(driveFiles.deletedAt),
  ) as SQL;

/** The project's documents (drive files of type document) marked client visible, newest first. */
export async function listPortalDocuments(db: Database, projectId: string, options: PageOptions): Promise<Page<PortalDocument>> {
  const base = documentFilter(projectId);
  const conditions: SQL[] = [base];
  if (options.cursor) {
    const [cur] = await db
      .select({ createdAt: driveFiles.createdAt, id: driveFiles.id })
      .from(driveFiles)
      .where(eq(driveFiles.id, options.cursor))
      .limit(1);
    if (cur) {
      conditions.push(
        sql`(${driveFiles.createdAt} < ${cur.createdAt} or (${driveFiles.createdAt} = ${cur.createdAt} and ${driveFiles.id} < ${cur.id}))`,
      );
    }
  }
  const [rows, count] = await Promise.all([
    db
      .select()
      .from(driveFiles)
      .where(and(...conditions))
      .orderBy(desc(driveFiles.createdAt), desc(driveFiles.id))
      .limit(options.limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(driveFiles).where(base),
  ]);
  return page(rows, options.limit, Number(count[0]?.count ?? 0), presentDocument);
}

/** One shared document of a project, for its download. */
export async function findPortalDocument(db: Database, projectId: string, documentId: string) {
  const [row] = await db
    .select()
    .from(driveFiles)
    .where(and(eq(driveFiles.id, documentId), documentFilter(projectId)))
    .limit(1);
  return row ?? null;
}

/** The thread of a project: messages marked client visible, newest first. */
export async function listPortalMessages(
  db: Database,
  projectId: string,
  contactIds: readonly string[],
  options: PageOptions,
): Promise<Page<PortalMessage>> {
  const base = and(eq(messages.projectId, projectId), eq(messages.clientVisible, true), isNull(messages.deletedAt)) as SQL;
  const conditions: SQL[] = [base];
  if (options.cursor) {
    const [cur] = await db
      .select({ createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .where(eq(messages.id, options.cursor))
      .limit(1);
    if (cur) {
      conditions.push(
        sql`(${messages.createdAt} < ${cur.createdAt} or (${messages.createdAt} = ${cur.createdAt} and ${messages.id} < ${cur.id}))`,
      );
    }
  }
  const [rows, count] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(options.limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(messages).where(base),
  ]);
  const names = await memberNames(db, rows.map((row) => row.senderId));
  return page(rows, options.limit, Number(count[0]?.count ?? 0), (row) =>
    presentMessage(
      { ...row, metadata: (row.metadata as Record<string, unknown> | null) ?? null },
      names,
      contactIds,
    ),
  );
}

/** A message as presented to the contact who sent it, for the answer of a post. */
export function presentSentMessage(
  row: { id: string; projectId: string; senderId: string; message: string; metadata: Record<string, unknown>; createdAt: Date },
  contactIds: readonly string[],
): PortalMessage {
  return presentMessage({ ...row, editedAt: null }, new Map(), contactIds);
}
