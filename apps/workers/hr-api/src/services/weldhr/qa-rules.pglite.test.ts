/**
 * The integrity rules from the WeldHR QA rounds of October 2026: things the
 * API used to accept that leave the data inconsistent (department loops,
 * double-booked shifts, assignments to deleted companies, offboarding someone
 * who has not started, a follow-up before its session, …).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createAssignment, listAssignments, listClientAccounts, requireCompany } from './assignments';
import { createDepartment, createEmployee, deleteDepartment, requireEmployee, updateDepartment } from './employees';
import { cancelChecklist, deleteChecklist, ensureDefaultTemplates, listTemplates, settleChecklist, startChecklist } from './lifecycle';
import {
  createCoachingLog,
  createEvaluation,
  createEvaluationForm,
  createKpiDefinition,
  createMilestone,
  updateMilestone,
} from './performance';
import { HrConflictError, HrNotFoundError, HrValidationError, addDays, todayIso } from './shared';
import {
  createAttendance,
  createLeaveRequest,
  createShift,
  importAttendance,
  leaveBalances,
  listLeaveRequests,
  reviewLeaveRequest,
  setAllowance,
  updateShift,
} from './time';

let db: Database;
let evaId: string;
let futureStarterId: string;

const TODAY = todayIso();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_eva', userId: 'user_eva', name: 'Eva Tester', email: 'eva@example.com', status: 'ACTIVE', memberType: 'INTERNAL' },
    { id: 'wm_finn', userId: 'user_finn', name: 'Finn Future', email: 'finn@example.com', status: 'ACTIVE', memberType: 'INTERNAL' },
  ]);
  const eva = await createEmployee(
    db,
    { userId: 'user_eva', firstName: 'Eva', lastName: 'Tester', email: 'eva@example.com', status: 'active', startDate: '2020-01-01' },
    { createdBy: 'user_hr' },
  );
  evaId = eva.id;
  const finn = await createEmployee(
    db,
    { userId: 'user_finn', firstName: 'Finn', lastName: 'Future', email: 'finn@example.com', status: 'onboarding', startDate: addDays(TODAY, 30) },
    { createdBy: 'user_hr' },
  );
  futureStarterId = finn.id;
}, 60_000);

describe('departments', () => {
  it('refuses to move a department under its own sub-department', async () => {
    const engineering = await createDepartment(db, { name: 'Engineering' });
    const backend = await createDepartment(db, { name: 'Backend', parentId: engineering.id });
    await expect(updateDepartment(db, engineering.id, { parentId: backend.id })).rejects.toBeInstanceOf(HrValidationError);
  });

  it('refuses a second department with the same name, whatever the case', async () => {
    await createDepartment(db, { name: 'Support' });
    await expect(createDepartment(db, { name: ' support ' })).rejects.toBeInstanceOf(HrConflictError);
  });

  it('moves the sub-departments of a deleted department up to its parent', async () => {
    const root = await createDepartment(db, { name: 'Operations' });
    const middle = await createDepartment(db, { name: 'Logistics', parentId: root.id });
    const leaf = await createDepartment(db, { name: 'Warehouse', parentId: middle.id });
    await deleteDepartment(db, middle.id);
    const [row] = await db.select().from(schema.hrDepartments).where(eq(schema.hrDepartments.id, leaf.id));
    expect(row!.parentId).toBe(root.id);
  });
});

describe('shifts and attendance', () => {
  const at = (time: string, date = '2026-11-02') => new Date(`${date}T${time}:00Z`).toISOString();

  it('refuses a shift that overlaps another shift of the same employee, but allows back-to-back ones', async () => {
    await createShift(db, { employeeId: evaId, startsAt: at('09:00'), endsAt: at('17:00') }, 'user_hr');
    await expect(createShift(db, { employeeId: evaId, startsAt: at('10:00'), endsAt: at('14:00') }, 'user_hr')).rejects.toBeInstanceOf(
      HrConflictError,
    );
    const evening = await createShift(db, { employeeId: evaId, startsAt: at('17:00'), endsAt: at('21:00') }, 'user_hr');
    // Moving it within its own slot is not an overlap with itself.
    await expect(updateShift(db, evening.id, { startsAt: at('17:30') })).resolves.toBeTruthy();
  });

  it('accepts a night shift that ends the next morning', async () => {
    const night = await createShift(db, { employeeId: evaId, startsAt: at('22:00', '2026-11-03'), endsAt: at('06:00', '2026-11-04') }, 'user_hr');
    expect(night.endsAt > night.startsAt).toBe(true);
  });

  it('refuses a break as long as the time worked', async () => {
    await expect(
      createAttendance(db, { employeeId: evaId, date: '2026-10-08', clockIn: at('09:00', '2026-10-08'), clockOut: at('10:00', '2026-10-08'), breakMinutes: 120 }, { createdBy: 'user_hr' }),
    ).rejects.toThrow('The break must be shorter');
  });

  it('dry-runs an import: reports unknown employees and bad times, writes nothing', async () => {
    const before = await db.select().from(schema.hrAttendanceRecords);
    const result = await importAttendance(
      db,
      [
        { employee: 'eva@example.com', date: '2026-10-06', clockIn: at('09:00', '2026-10-06'), clockOut: at('17:00', '2026-10-06') },
        { employee: 'nobody@example.com', date: '2026-10-06' },
        { employee: 'eva@example.com', date: '2026-10-07', clockIn: at('17:00', '2026-10-07'), clockOut: at('09:00', '2026-10-07') },
      ],
      'user_hr',
      { dryRun: true },
    );
    expect(result.created).toBe(1);
    expect(result.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(result.errors[0]!.reason).toContain('nobody@example.com');
    expect(await db.select().from(schema.hrAttendanceRecords)).toHaveLength(before.length);
  });
});

describe('leave balances', () => {
  it('pro-rates the default allowance for someone who starts during the year', async () => {
    await db.insert(schema.hrLeaveTypes).values({ id: 'hrlvt_annual', name: 'Annual leave', defaultAllowanceDays: 20 });
    await db.update(schema.hrEmployees).set({ startDate: '2026-10-01' }).where(eq(schema.hrEmployees.id, evaId));
    const annual = (await leaveBalances(db, evaId, 2026)).find((b) => b.leaveTypeId === 'hrlvt_annual')!;
    // 92 of 365 days → 5.04 days, rounded to half days.
    expect(annual).toMatchObject({ allowance: 5, fullAllowance: 20, prorated: true });
    const nextYear = (await leaveBalances(db, evaId, 2027)).find((b) => b.leaveTypeId === 'hrlvt_annual')!;
    expect(nextYear).toMatchObject({ allowance: 20, prorated: false });
    await db.update(schema.hrEmployees).set({ startDate: '2020-01-01' }).where(eq(schema.hrEmployees.id, evaId));
  });
});

describe('leave over the allowance', () => {
  // A 10-day allowance; 2027 so nothing above (shifts, attendance) gets in the way.
  const request = (startDate: string, endDate: string, leaveTypeId: string) =>
    createLeaveRequest(db, { employeeId: evaId, leaveTypeId, startDate, endDate }, 'user_hr');

  beforeAll(async () => {
    await db.insert(schema.hrLeaveTypes).values([
      { id: 'hrlvt_strict', name: 'Strict leave', defaultAllowanceDays: 10, overAllowance: 'block' },
      { id: 'hrlvt_lenient', name: 'Lenient leave', defaultAllowanceDays: 10 },
    ]);
  });

  it('lets a type set to allow go over (the dialogs only warn)', async () => {
    await expect(request('2027-03-01', '2027-03-19', 'hrlvt_lenient')).resolves.toMatchObject({ days: 15, status: 'pending' });
  });

  it('refuses a request that does not fit, counting pending requests', async () => {
    const first = await request('2027-01-04', '2027-01-08', 'hrlvt_strict'); // 5 days, pending
    await expect(request('2027-02-01', '2027-02-08', 'hrlvt_strict')).rejects.toThrow('only 5 days of Strict leave are left');
    await expect(request('2027-02-01', '2027-02-05', 'hrlvt_strict')).resolves.toMatchObject({ days: 5 });
    await reviewLeaveRequest(db, first.id, { decision: 'approved' }, 'user_hr');
  });

  it('refuses to approve past the allowance, e.g. after the allowance was lowered', async () => {
    const pending = (await listLeaveRequests(db, { employeeId: evaId, status: 'pending' })).find((r) => r.leaveTypeId === 'hrlvt_strict')!;
    await setAllowance(db, { employeeId: evaId, leaveTypeId: 'hrlvt_strict', year: 2027, days: 7 });
    await expect(reviewLeaveRequest(db, pending.id, { decision: 'approved' }, 'user_hr')).rejects.toBeInstanceOf(HrConflictError);
    // Rejecting is always possible.
    await expect(reviewLeaveRequest(db, pending.id, { decision: 'rejected' }, 'user_hr')).resolves.toMatchObject({ status: 'rejected' });
  });
});

describe('client assignments', () => {
  it('refuses a second running assignment to the same client', async () => {
    await db.insert(schema.companies).values({ id: 'cmp_beta', name: 'Import Beta BV', displayName: 'Import Beta BV' });
    await createAssignment(db, { employeeId: evaId, companyId: 'cmp_beta', startDate: '2026-01-01', allocationPercent: 100 }, 'user_hr');
    await expect(
      createAssignment(db, { employeeId: evaId, companyId: 'cmp_beta', startDate: '2026-06-01', allocationPercent: 50 }, 'user_hr'),
    ).rejects.toBeInstanceOf(HrConflictError);
  });

  it('treats an assignment to a company deleted in WeldCRM as history', async () => {
    await db.insert(schema.companies).values({ id: 'cmp_gone', name: 'E2E Cascade BV', displayName: 'E2E Cascade BV' });
    await createAssignment(db, { employeeId: evaId, companyId: 'cmp_gone', startDate: '2026-01-01' }, 'user_hr');
    await db.update(schema.companies).set({ deletedAt: new Date() }).where(eq(schema.companies.id, 'cmp_gone'));

    const all = await listAssignments(db, { employeeId: evaId });
    expect(all.find((a) => a.companyId === 'cmp_gone')).toMatchObject({ companyDeleted: true, isActive: false });
    expect((await listAssignments(db, { employeeId: evaId, activeOnly: true })).some((a) => a.companyId === 'cmp_gone')).toBe(false);
    expect((await listClientAccounts(db)).some((c) => c.companyId === 'cmp_gone')).toBe(false);
    await expect(requireCompany(db, 'cmp_gone')).rejects.toThrow('E2E Cascade BV was deleted in WeldCRM');
    await expect(requireCompany(db, 'cmp_gone')).rejects.toBeInstanceOf(HrNotFoundError);
  });
});

describe('offboarding', () => {
  let templateId: string;

  beforeAll(async () => {
    await ensureDefaultTemplates(db);
    templateId = (await listTemplates(db, 'offboarding'))[0]!.id;
  });

  it('refuses to offboard someone who has not started, unless forced', async () => {
    await expect(startChecklist(db, futureStarterId, { templateId, anchorDate: addDays(TODAY, 60) }, 'user_hr')).rejects.toBeInstanceOf(
      HrConflictError,
    );
  });

  it('needs a last working day', async () => {
    await expect(startChecklist(db, futureStarterId, { templateId, force: true }, 'user_hr')).rejects.toBeInstanceOf(HrValidationError);
  });

  it('keeps the last working day on the checklist; cancelling leaves the employee as they were', async () => {
    const lastDay = addDays(TODAY, 60);
    const checklist = await startChecklist(db, futureStarterId, { templateId, anchorDate: lastDay, force: true }, 'user_hr');
    expect(checklist.anchorDate).toBe(lastDay);
    // The end date is only written when the offboarding completes.
    expect(await requireEmployee(db, futureStarterId)).toMatchObject({ status: 'offboarding', endDate: null });
    const tasks = await db.select().from(schema.hrChecklistTasks).where(eq(schema.hrChecklistTasks.checklistId, checklist.id));
    expect(tasks.every((task) => task.dueDate !== null && task.dueDate >= TODAY)).toBe(true);

    await cancelChecklist(db, checklist.id);
    expect(await requireEmployee(db, futureStarterId)).toMatchObject({ status: 'onboarding', endDate: null });
    await deleteChecklist(db, checklist.id);
  });

  it('writes the last working day as the end date when the offboarding completes', async () => {
    const lastDay = addDays(TODAY, 45);
    const checklist = await startChecklist(db, futureStarterId, { templateId, anchorDate: lastDay, force: true }, 'user_hr');
    await db.update(schema.hrChecklistTasks).set({ completedAt: new Date() }).where(eq(schema.hrChecklistTasks.checklistId, checklist.id));
    await settleChecklist(db, checklist.id);
    expect(await requireEmployee(db, futureStarterId)).toMatchObject({ status: 'terminated', endDate: lastDay });
  });
});

describe('coaching, evaluations, KPIs and milestones', () => {
  it('refuses a follow-up date before the session', async () => {
    await expect(
      createCoachingLog(db, { employeeId: evaId, sessionDate: '2026-10-08', topic: 'Call quality', followUpDate: '2026-10-01' }, 'user_hr'),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('refuses to submit an evaluation with unscored criteria or a period that has not started', async () => {
    const form = await createEvaluationForm(db, {
      name: 'Scorecard',
      criteria: [
        { id: 'quality', label: 'Quality of work', weight: 50, maxScore: 5 },
        { id: 'speed', label: 'Speed', weight: 50, maxScore: 5 },
      ],
    });
    await expect(
      createEvaluation(db, { employeeId: evaId, formId: form.id, scores: [{ criterionId: 'quality', score: 4 }], submit: true }, 'user_hr'),
    ).rejects.toThrow('Missing: Speed');
    const scores = [
      { criterionId: 'quality', score: 4 },
      { criterionId: 'speed', score: 3 },
    ];
    await expect(
      createEvaluation(db, { employeeId: evaId, formId: form.id, scores, periodStart: addDays(TODAY, 10), submit: true }, 'user_hr'),
    ).rejects.toBeInstanceOf(HrValidationError);
    // A draft is fine either way.
    await expect(createEvaluation(db, { employeeId: evaId, formId: form.id, scores: scores.slice(0, 1) }, 'user_hr')).resolves.toBeTruthy();
  });

  it('refuses a negative target for a percentage KPI', async () => {
    await expect(createKpiDefinition(db, { name: 'CSAT 2', unit: 'percent', target: -50 })).rejects.toBeInstanceOf(HrValidationError);
    await expect(createKpiDefinition(db, { name: 'Net change', unit: 'number', target: -50 })).resolves.toBeTruthy();
  });

  it('keeps milestone status and achieved date in step', async () => {
    const planned = await createMilestone(db, { employeeId: evaId, title: 'Certified', status: 'planned', achievedAt: '2026-10-05' }, 'user_hr');
    expect(planned.status).toBe('achieved');
    const { milestone } = await updateMilestone(db, planned.id, { status: 'in_progress' });
    expect(milestone).toMatchObject({ status: 'in_progress', achievedAt: null });
    await expect(updateMilestone(db, planned.id, { status: 'missed', achievedAt: '2026-10-06' })).rejects.toBeInstanceOf(HrValidationError);
  });
});
