/**
 * Announcements: news from HR to employees, read in My HR and the WeldHR app.
 *
 * The audience is every active employee, or those in `department_ids` and the
 * departments under them. Reading one writes a row in `hr_announcement_reads`
 * the first time, which is what the unread badge and HR's "who has read it"
 * view count. The body is plain text.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { departmentLineage, displayNameOf, employeesInDepartments, requireEmployee } from './employees';
import { HrNotFoundError, memberNames } from './shared';

const an = schema.hrAnnouncements;
const ar = schema.hrAnnouncementReads;
const dep = schema.hrDepartments;

type AnnouncementRow = typeof an.$inferSelect;

export async function requireAnnouncement(db: Database, id: string) {
  const [row] = await db.select().from(an).where(and(eq(an.id, id), isNull(an.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Announcement', id);
  return row;
}

async function departmentNameMap(db: Database, rows: AnnouncementRow[]) {
  const ids = [...new Set(rows.flatMap((r) => r.departmentIds))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const found = await db.select({ id: dep.id, name: dep.name }).from(dep).where(inArray(dep.id, ids));
  for (const row of found) out.set(row.id, row.name);
  return out;
}

/** Pinned first, then newest. */
function byPinnedThenNewest(a: AnnouncementRow, b: AnnouncementRow) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.publishedAt.getTime() - a.publishedAt.getTime();
}

/** Every announcement with its audience size and how many of them have read it, as HR lists them. */
export async function listAnnouncements(db: Database) {
  const rows = (await db.select().from(an).where(isNull(an.deletedAt)).orderBy(desc(an.publishedAt)).limit(500)).sort(
    byPinnedThenNewest,
  );
  if (rows.length === 0) return [];
  // One audience lookup per distinct department set, not per announcement.
  const audienceKeys = [...new Set(rows.map((r) => [...r.departmentIds].sort().join(',')))];
  const audiences = new Map(
    await Promise.all(
      audienceKeys.map(async (key) => {
        const employees = await employeesInDepartments(db, key ? key.split(',') : []);
        return [key, new Set(employees.map((e) => e.id))] as const;
      }),
    ),
  );
  const [reads, departments, authors] = await Promise.all([
    db
      .select({ announcementId: ar.announcementId, employeeId: ar.employeeId })
      .from(ar)
      .where(inArray(ar.announcementId, rows.map((r) => r.id))),
    departmentNameMap(db, rows),
    memberNames(db, rows.map((r) => r.createdBy)),
  ]);
  return rows.map((row) => {
    const audience = audiences.get([...row.departmentIds].sort().join(',')) ?? new Set<string>();
    const readCount = reads.filter((r) => r.announcementId === row.id && audience.has(r.employeeId)).length;
    return {
      ...row,
      departmentNames: row.departmentIds.map((id) => departments.get(id)).filter((n): n is string => Boolean(n)),
      createdByName: row.createdBy ? authors.get(row.createdBy) ?? null : null,
      audienceCount: audience.size,
      readCount,
    };
  });
}

export async function announcementWithDetails(db: Database, id: string) {
  const row = (await listAnnouncements(db)).find((a) => a.id === id);
  if (!row) throw new HrNotFoundError('Announcement', id);
  return row;
}

async function assertDepartments(db: Database, ids: string[]) {
  if (ids.length === 0) return;
  const found = await db.select({ id: dep.id }).from(dep).where(and(inArray(dep.id, ids), isNull(dep.deletedAt)));
  if (found.length !== new Set(ids).size) throw new HrNotFoundError('Department', ids.join(','));
}

export async function createAnnouncement(
  db: Database,
  input: { title: string; body: string; pinned?: boolean; departmentIds?: string[] },
  createdBy: string,
) {
  const departmentIds = [...new Set(input.departmentIds ?? [])];
  await assertDepartments(db, departmentIds);
  const [row] = await db
    .insert(an)
    .values({
      id: generateId('hrann'),
      title: input.title.trim(),
      body: input.body.trim(),
      pinned: input.pinned ?? false,
      departmentIds,
      createdBy,
    })
    .returning();
  return row!;
}

export async function updateAnnouncement(
  db: Database,
  id: string,
  input: { title?: string; body?: string; pinned?: boolean; departmentIds?: string[] },
) {
  await requireAnnouncement(db, id);
  const departmentIds = input.departmentIds === undefined ? undefined : [...new Set(input.departmentIds)];
  if (departmentIds) await assertDepartments(db, departmentIds);
  const [row] = await db
    .update(an)
    .set({
      title: input.title?.trim(),
      body: input.body?.trim(),
      pinned: input.pinned,
      departmentIds,
      updatedAt: new Date(),
    })
    .where(eq(an.id, id))
    .returning();
  return row!;
}

export async function deleteAnnouncement(db: Database, id: string) {
  await requireAnnouncement(db, id);
  const now = new Date();
  await db.update(an).set({ deletedAt: now, updatedAt: now }).where(eq(an.id, id));
}

export async function markAnnouncementNotified(db: Database, id: string) {
  await db.update(an).set({ notifiedAt: new Date() }).where(eq(an.id, id));
}

/** The audience of an announcement, each with when they read it (null: not yet). */
export async function announcementReads(db: Database, id: string) {
  const row = await requireAnnouncement(db, id);
  const [audience, reads] = await Promise.all([
    employeesInDepartments(db, row.departmentIds),
    db.select({ employeeId: ar.employeeId, readAt: ar.readAt }).from(ar).where(eq(ar.announcementId, id)),
  ]);
  const readAt = new Map(reads.map((r) => [r.employeeId, r.readAt]));
  return audience
    .map((e) => ({ employeeId: e.id, employeeName: displayNameOf(e), readAt: readAt.get(e.id) ?? null }))
    .sort((a, b) => {
      if (Boolean(a.readAt) !== Boolean(b.readAt)) return a.readAt ? 1 : -1;
      return a.employeeName.localeCompare(b.employeeName);
    });
}

/** Who should get a push about it: the audience members linked to a workspace member. */
export async function announcementRecipients(db: Database, row: AnnouncementRow) {
  const audience = await employeesInDepartments(db, row.departmentIds);
  return [...new Set(audience.map((e) => e.userId).filter((v): v is string => Boolean(v)))];
}

// ---------------------------------------------------------------------------
// Employee side
// ---------------------------------------------------------------------------

function meantFor(row: Pick<AnnouncementRow, 'departmentIds'>, lineage: Set<string>) {
  return row.departmentIds.length === 0 || row.departmentIds.some((id) => lineage.has(id));
}

/** Announcements meant for the employee, pinned first, each with whether they read it, and the unread count. */
export async function announcementsForEmployee(db: Database, employeeId: string) {
  const employee = await requireEmployee(db, employeeId);
  const lineage = await departmentLineage(db, employee.departmentId);
  const rows = (await db.select().from(an).where(isNull(an.deletedAt)).orderBy(desc(an.publishedAt)).limit(200))
    .filter((row) => meantFor(row, lineage))
    .sort(byPinnedThenNewest);
  const reads =
    rows.length === 0
      ? []
      : await db
          .select({ announcementId: ar.announcementId, readAt: ar.readAt })
          .from(ar)
          .where(and(eq(ar.employeeId, employeeId), inArray(ar.announcementId, rows.map((r) => r.id))));
  const readAt = new Map(reads.map((r) => [r.announcementId, r.readAt]));
  const authors = await memberNames(db, rows.map((r) => r.createdBy));
  const announcements = rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    pinned: row.pinned,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    createdByName: row.createdBy ? authors.get(row.createdBy) ?? null : null,
    readAt: readAt.get(row.id) ?? null,
  }));
  return { announcements, unread: announcements.filter((a) => !a.readAt).length };
}

/** The number the badges show, without loading the bodies. */
export async function unreadAnnouncementCount(db: Database, employeeId: string) {
  const employee = await requireEmployee(db, employeeId);
  const lineage = await departmentLineage(db, employee.departmentId);
  const rows = await db
    .select({ id: an.id, departmentIds: an.departmentIds })
    .from(an)
    .leftJoin(ar, and(eq(ar.announcementId, an.id), eq(ar.employeeId, employeeId)))
    .where(and(isNull(an.deletedAt), sql`${ar.id} is null`))
    .limit(500);
  return rows.filter((row) => meantFor(row, lineage)).length;
}

/** The employee opened it. Only the first read is kept. */
export async function markAnnouncementRead(db: Database, id: string, employeeId: string) {
  const row = await requireAnnouncement(db, id);
  const employee = await requireEmployee(db, employeeId);
  if (!meantFor(row, await departmentLineage(db, employee.departmentId))) throw new HrNotFoundError('Announcement', id);
  await db
    .insert(ar)
    .values({ id: generateId('hranr'), announcementId: id, employeeId })
    .onConflictDoNothing({ target: [ar.announcementId, ar.employeeId] });
  const [read] = await db
    .select({ readAt: ar.readAt })
    .from(ar)
    .where(and(eq(ar.announcementId, id), eq(ar.employeeId, employeeId)))
    .limit(1);
  return { id, readAt: read?.readAt ?? new Date() };
}
