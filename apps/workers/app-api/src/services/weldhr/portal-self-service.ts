/**
 * Data the workforce portal serves to a signed-in employee, and the client
 * support request. Every function takes the principal's id from the session —
 * never from the request — so a portal user can only ever reach their own rows.
 */

import { and, asc, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { activeClientsFor, displayNameOf, requireEmployee } from './employees';
import { settleChecklist } from './lifecycle';
import { listCoachingLogs, listEvaluations, listKpiValues, listMilestones } from './performance';
import { addDays, HrNotFoundError, HrValidationError, todayIso } from './shared';
import {
  leaveBalances,
  listAttendance,
  listLeaveRequests,
  listLeaveTypes,
  listShifts,
  openClockRecord,
} from './time';

/** Public profile of the signed-in employee. Nothing from the sensitive block. */
export async function employeeProfile(db: Database, employeeId: string) {
  const e = await requireEmployee(db, employeeId);
  const [department, manager, clients] = await Promise.all([
    e.departmentId
      ? db.select({ name: schema.hrDepartments.name }).from(schema.hrDepartments).where(eq(schema.hrDepartments.id, e.departmentId)).limit(1)
      : Promise.resolve([]),
    e.managerId
      ? db
          .select({ firstName: schema.hrEmployees.firstName, lastName: schema.hrEmployees.lastName, preferredName: schema.hrEmployees.preferredName, email: schema.hrEmployees.email })
          .from(schema.hrEmployees)
          .where(eq(schema.hrEmployees.id, e.managerId))
          .limit(1)
      : Promise.resolve([]),
    activeClientsFor(db, [e.id]),
  ]);
  return {
    id: e.id,
    displayName: displayNameOf(e),
    firstName: e.firstName,
    lastName: e.lastName,
    email: e.email,
    phone: e.phone,
    avatarUrl: e.avatarUrl,
    jobTitle: e.jobTitle,
    employeeNumber: e.employeeNumber,
    status: e.status,
    employmentType: e.employmentType,
    startDate: e.startDate,
    location: e.location,
    departmentName: department[0]?.name ?? null,
    manager: manager[0] ? { displayName: displayNameOf(manager[0]), email: manager[0].email } : null,
    clients: clients.get(e.id) ?? [],
  };
}

export async function employeeTasks(db: Database, employeeId: string) {
  const t = schema.hrChecklistTasks;
  const chk = schema.hrChecklists;
  const rows = await db
    .select({ task: t, checklistName: chk.name, checklistKind: chk.kind, checklistStatus: chk.status })
    .from(t)
    .innerJoin(chk, eq(chk.id, t.checklistId))
    .where(and(eq(t.employeeId, employeeId), eq(t.visibleToEmployee, true), inArray(chk.status, ['in_progress', 'completed'])))
    .orderBy(asc(t.dueDate), asc(t.sortOrder));
  return rows.map((r) => ({
    id: r.task.id,
    title: r.task.title,
    description: r.task.description,
    dueDate: r.task.dueDate,
    assigneeRole: r.task.assigneeRole,
    completedAt: r.task.completedAt,
    canComplete: r.task.assigneeRole === 'employee' && r.checklistStatus === 'in_progress',
    checklistName: r.checklistName,
    checklistKind: r.checklistKind,
  }));
}

export async function completeEmployeeTask(db: Database, employeeId: string, taskId: string, done: boolean) {
  const t = schema.hrChecklistTasks;
  const [task] = await db.select().from(t).where(eq(t.id, taskId)).limit(1);
  if (!task || task.employeeId !== employeeId || !task.visibleToEmployee) throw new HrNotFoundError('Task', taskId);
  if (task.assigneeRole !== 'employee') throw new HrValidationError('This task is completed by your team, not by you');
  const now = new Date();
  await db
    .update(t)
    .set(done ? { completedAt: now, completedBy: `portal:${employeeId}`, updatedAt: now } : { completedAt: null, completedBy: null, updatedAt: now })
    .where(eq(t.id, taskId));
  return { checklistId: task.checklistId, outcome: await settleChecklist(db, task.checklistId) };
}

export async function employeeOverview(db: Database, employeeId: string) {
  const today = todayIso();
  const year = Number(today.slice(0, 4));
  const [profile, openClock, shifts, balances, tasks, coaching, evaluations, milestones] = await Promise.all([
    employeeProfile(db, employeeId),
    openClockRecord(db, employeeId),
    listShifts(db, { from: today, to: addDays(today, 13), employeeId }),
    leaveBalances(db, employeeId, year),
    employeeTasks(db, employeeId),
    listCoachingLogs(db, { employeeId, visibilities: ['employee', 'client'] }),
    listEvaluations(db, { employeeId, status: 'submitted,acknowledged' }),
    listMilestones(db, { employeeId }),
  ]);
  return {
    profile,
    clock: { clockedIn: Boolean(openClock), since: openClock?.clockIn ?? null },
    upcomingShifts: shifts.map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, companyName: s.companyName })),
    leaveBalances: balances,
    openTasks: tasks.filter((t) => !t.completedAt).length,
    toAcknowledge: {
      coaching: coaching.filter((c) => !c.acknowledgedAt).length,
      evaluations: evaluations.filter((e) => e.status === 'submitted').length,
    },
    latestEvaluation: evaluations[0]
      ? { id: evaluations[0].id, overallScore: evaluations[0].overallScore, formName: evaluations[0].formName, submittedAt: evaluations[0].submittedAt }
      : null,
    milestones: {
      achieved: milestones.filter((m) => m.status === 'achieved').length,
      open: milestones.filter((m) => m.status === 'planned' || m.status === 'in_progress').length,
    },
  };
}

export async function employeeAttendance(db: Database, employeeId: string, from: string, to: string) {
  const [records, shifts] = await Promise.all([
    listAttendance(db, { employeeId, from, to, limit: 500 }),
    listShifts(db, { from, to, employeeId }),
  ]);
  return {
    records: records.data.map((r) => ({
      id: r.id,
      date: r.date,
      clockIn: r.clockIn,
      clockOut: r.clockOut,
      breakMinutes: r.breakMinutes,
      workedMinutes: r.workedMinutes,
      lateMinutes: r.lateMinutes,
      status: r.status,
      source: r.source,
      approved: Boolean(r.approvedAt),
      companyName: r.companyName,
    })),
    shifts: shifts.map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, companyName: s.companyName, notes: s.notes })),
  };
}

export async function employeeLeave(db: Database, employeeId: string) {
  const year = new Date().getUTCFullYear();
  const [types, balances, requests] = await Promise.all([
    listLeaveTypes(db),
    leaveBalances(db, employeeId, year),
    listLeaveRequests(db, { employeeId }),
  ]);
  return {
    types: types.map((t) => ({ id: t.id, name: t.name, color: t.color, requiresApproval: t.requiresApproval })),
    balances,
    requests: requests.map((r) => ({
      id: r.id,
      leaveTypeId: r.leaveTypeId,
      leaveTypeName: r.leaveTypeName,
      leaveTypeColor: r.leaveTypeColor,
      startDate: r.startDate,
      endDate: r.endDate,
      days: r.days,
      reason: r.reason,
      status: r.status,
      reviewNote: r.reviewNote,
      reviewedAt: r.reviewedAt,
    })),
  };
}

export async function employeeCoaching(db: Database, employeeId: string) {
  const logs = await listCoachingLogs(db, { employeeId, visibilities: ['employee', 'client'] });
  return logs.map((l) => ({
    id: l.id,
    sessionDate: l.sessionDate,
    category: l.category,
    topic: l.topic,
    notes: l.notes,
    actionItems: l.actionItems,
    followUpDate: l.followUpDate,
    status: l.status,
    coachName: l.coachName,
    acknowledgedAt: l.acknowledgedAt,
    employeeComment: l.employeeComment,
  }));
}

export async function employeeEvaluations(db: Database, employeeId: string) {
  const rows = await listEvaluations(db, { employeeId, status: 'submitted,acknowledged' });
  return rows.map((r) => ({
    id: r.id,
    formName: r.formName,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    criteria: r.criteria,
    scores: r.scores,
    overallScore: r.overallScore,
    summary: r.summary,
    status: r.status,
    evaluatorName: r.evaluatorName,
    submittedAt: r.submittedAt,
    acknowledgedAt: r.acknowledgedAt,
    employeeComment: r.employeeComment,
  }));
}

export async function employeePerformance(db: Database, employeeId: string) {
  const since = addDays(todayIso(), -365);
  const [kpis, milestones] = await Promise.all([
    listKpiValues(db, { employeeId, from: since }),
    listMilestones(db, { employeeId }),
  ]);
  return {
    kpis: kpis.map((k) => ({
      id: k.id,
      kpiId: k.kpiId,
      kpiName: k.kpiName,
      unit: k.unit,
      direction: k.direction,
      target: k.target,
      value: k.value,
      onTarget: k.onTarget,
      periodStart: k.periodStart,
      periodEnd: k.periodEnd,
    })),
    milestones: milestones.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      type: m.type,
      status: m.status,
      dueDate: m.dueDate,
      achievedAt: m.achievedAt,
      companyName: m.companyName,
    })),
  };
}

// ---------------------------------------------------------------------------
// Client support requests → WeldDesk ticket
// ---------------------------------------------------------------------------

/**
 * A client's message from the portal becomes a WeldDesk ticket linked to the
 * CRM person, so the account team answers it where they already work.
 */
export async function createClientRequest(
  db: Database,
  input: { personId: string | null; companyName: string | null; email: string; displayName: string | null; subject: string; message: string },
) {
  const id = generateId('tkt');
  const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const now = new Date();
  const customerName = input.displayName?.trim() || input.email.split('@')[0] || 'Client';
  const description = input.companyName ? `${input.message}\n\n— Sent from the client portal (${input.companyName})` : input.message;
  await db.insert(schema.helpdeskTickets).values({
    id,
    ticketNumber,
    contactId: input.personId,
    customerName,
    customerEmail: input.email,
    subject: input.subject,
    description,
    channel: 'web',
    status: 'new',
    priority: 'medium',
    createdAt: now,
    updatedAt: now,
  });
  return { id, ticketNumber, subject: input.subject, status: 'new', createdAt: now.toISOString() };
}

/** Recent tickets this client contact opened. */
export async function clientRequests(db: Database, email: string) {
  const t = schema.helpdeskTickets;
  const rows = await db
    .select({ id: t.id, ticketNumber: t.ticketNumber, subject: t.subject, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt })
    .from(t)
    .where(and(eq(t.customerEmail, email), isNull(t.deletedAt), gte(t.createdAt, new Date(Date.now() - 365 * 86400000))))
    .orderBy(desc(t.createdAt))
    .limit(100);
  return rows;
}
