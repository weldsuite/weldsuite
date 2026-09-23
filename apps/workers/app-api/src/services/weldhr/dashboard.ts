/**
 * WeldHR landing-page rollup. One request, a handful of cheap aggregates.
 */

import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { displayNameOf } from './employees';
import { listClientAccounts } from './assignments';
import { onLeaveOn } from './time';
import { addDays, todayIso } from './shared';

export async function hrDashboard(db: Database) {
  const today = todayIso();
  const e = schema.hrEmployees;
  const att = schema.hrAttendanceRecords;
  const tsk = schema.hrChecklistTasks;
  const chk = schema.hrChecklists;
  const lr = schema.hrLeaveRequests;
  const co = schema.hrCoachingLogs;
  const ev = schema.hrEvaluations;

  const [statusCounts, todayAttendance, openTasks, pendingLeave, followUps, recentEvaluations, avgScore, upcomingStarts, onLeave, clients] =
    await Promise.all([
      db
        .select({ status: e.status, count: sql<number>`count(*)` })
        .from(e)
        .where(isNull(e.deletedAt))
        .groupBy(e.status),
      db
        .select({
          status: att.status,
          count: sql<number>`count(*)`,
          clockedIn: sql<number>`count(*) filter (where ${att.clockIn} is not null and ${att.clockOut} is null)`,
        })
        .from(att)
        .where(eq(att.date, today))
        .groupBy(att.status),
      db
        .select({
          open: sql<number>`count(*)`,
          overdue: sql<number>`count(*) filter (where ${tsk.dueDate} < ${today})`,
        })
        .from(tsk)
        .innerJoin(chk, eq(chk.id, tsk.checklistId))
        .where(and(isNull(tsk.completedAt), eq(chk.status, 'in_progress'))),
      db.select({ count: sql<number>`count(*)` }).from(lr).where(eq(lr.status, 'pending')),
      db
        .select({ count: sql<number>`count(*)` })
        .from(co)
        .where(and(isNull(co.deletedAt), sql`${co.status} <> 'closed'`, lte(co.followUpDate, today))),
      db
        .select({
          id: ev.id,
          employeeId: ev.employeeId,
          overallScore: ev.overallScore,
          status: ev.status,
          submittedAt: ev.submittedAt,
          firstName: e.firstName,
          lastName: e.lastName,
          preferredName: e.preferredName,
        })
        .from(ev)
        .innerJoin(e, eq(e.id, ev.employeeId))
        .where(and(isNull(ev.deletedAt), isNull(e.deletedAt), inArray(ev.status, ['submitted', 'acknowledged'])))
        .orderBy(desc(ev.submittedAt))
        .limit(5),
      db
        .select({ average: sql<number>`avg(${ev.overallScore})` })
        .from(ev)
        .where(
          and(
            isNull(ev.deletedAt),
            inArray(ev.status, ['submitted', 'acknowledged']),
            gte(ev.submittedAt, new Date(`${addDays(today, -90)}T00:00:00Z`)),
          ),
        ),
      db
        .select({
          id: e.id,
          firstName: e.firstName,
          lastName: e.lastName,
          preferredName: e.preferredName,
          jobTitle: e.jobTitle,
          startDate: e.startDate,
          status: e.status,
        })
        .from(e)
        .where(and(isNull(e.deletedAt), gte(e.startDate, today), lte(e.startDate, addDays(today, 30))))
        .orderBy(e.startDate)
        .limit(10),
      onLeaveOn(db, today),
      listClientAccounts(db),
    ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row.status] = Number(row.count);
  const attendanceByStatus: Record<string, number> = {};
  let clockedIn = 0;
  for (const row of todayAttendance) {
    attendanceByStatus[row.status] = Number(row.count);
    clockedIn += Number(row.clockedIn);
  }

  return {
    headcount: {
      total: Object.entries(byStatus)
        .filter(([status]) => status !== 'terminated')
        .reduce((s, [, n]) => s + n, 0),
      byStatus,
    },
    today: {
      date: today,
      clockedIn,
      byStatus: attendanceByStatus,
      onLeave,
    },
    lifecycle: {
      openTasks: Number(openTasks[0]?.open ?? 0),
      overdueTasks: Number(openTasks[0]?.overdue ?? 0),
      upcomingStarts: upcomingStarts.map((r) => ({ ...r, displayName: displayNameOf(r) })),
    },
    pendingLeaveRequests: Number(pendingLeave[0]?.count ?? 0),
    coachingFollowUpsDue: Number(followUps[0]?.count ?? 0),
    evaluations: {
      averageScore90d: avgScore[0]?.average !== null && avgScore[0]?.average !== undefined
        ? Math.round(Number(avgScore[0].average) * 10) / 10
        : null,
      recent: recentEvaluations.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        employeeName: displayNameOf(r),
        overallScore: r.overallScore,
        status: r.status,
        submittedAt: r.submittedAt,
      })),
    },
    clients: clients.filter((c) => c.activeCount > 0),
  };
}
