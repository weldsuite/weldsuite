/**
 * Sick reports: reporting sick and recovered, what counts as a day, and the
 * rules that keep an employee's reports from overlapping.
 *
 * "Today" is Wednesday 18 March 2026 throughout.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  absenceDays,
  absenceStatus,
  createAbsence,
  deleteAbsence,
  employeeAbsences,
  listAbsences,
  recoverAbsence,
  reportSick,
  updateAbsence,
} from './absences';
import { HrConflictError, HrNotFoundError, HrValidationError } from './shared';

const TODAY = '2026-03-18';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_hr', userId: 'user_hr', name: 'Hanna HR', email: 'hanna@example.com', status: 'ACTIVE', memberType: 'INTERNAL' },
  ]);
  await db.insert(schema.hrDepartments).values([{ id: 'dep_support', name: 'Support' }]);
  await db.insert(schema.hrEmployees).values([
    { id: 'emp_ann', firstName: 'Ann', lastName: 'Adams', email: 'ann@example.com', status: 'active', userId: 'user_ann', departmentId: 'dep_support' },
    { id: 'emp_ben', firstName: 'Ben', lastName: 'Baker', email: 'ben@example.com', status: 'active', userId: 'user_ben' },
    { id: 'emp_deleted', firstName: 'Del', lastName: 'Eted', email: 'del@example.com', status: 'active', deletedAt: new Date() },
  ]);
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.hrAbsences);
});

describe('absenceDays', () => {
  it('counts working days up to today while the report is open', () => {
    // Fri 13, Mon 16, Tue 17, Wed 18.
    expect(absenceDays({ startDate: '2026-03-13', endDate: null, firstDay: 'full' }, TODAY)).toBe(4);
  });

  it('stops at the last sick day and takes half off a half first day', () => {
    expect(absenceDays({ startDate: '2026-03-13', endDate: '2026-03-16', firstDay: 'full' }, TODAY)).toBe(2);
    expect(absenceDays({ startDate: '2026-03-13', endDate: '2026-03-16', firstDay: 'half' }, TODAY)).toBe(1.5);
  });

  it('does not take half a day off a first day in the weekend', () => {
    expect(absenceDays({ startDate: '2026-03-14', endDate: '2026-03-16', firstDay: 'half' }, TODAY)).toBe(1);
  });
});

describe('absenceStatus', () => {
  it('is ongoing until the last sick day has passed', () => {
    expect(absenceStatus(null, TODAY)).toBe('ongoing');
    expect(absenceStatus(TODAY, TODAY)).toBe('ongoing');
    expect(absenceStatus('2026-03-17', TODAY)).toBe('completed');
  });
});

describe('reportSick', () => {
  it('opens a report for the employee', async () => {
    const row = await reportSick(db, 'emp_ann', { startDate: TODAY, firstDay: 'half', note: '  Reachable by phone  ' }, 'user_ann', TODAY);

    expect(row).toMatchObject({
      employeeId: 'emp_ann',
      startDate: TODAY,
      endDate: null,
      firstDay: 'half',
      note: 'Reachable by phone',
      reportedBy: 'user_ann',
      recoveredReportedBy: null,
    });
  });

  it('refuses a second report while one is open', async () => {
    await reportSick(db, 'emp_ann', { startDate: '2026-03-16' }, 'user_ann', TODAY);

    await expect(reportSick(db, 'emp_ann', { startDate: TODAY }, 'user_ann', TODAY)).rejects.toThrow(HrConflictError);
    // Someone else reporting sick is unaffected.
    await expect(reportSick(db, 'emp_ben', { startDate: TODAY }, 'user_ben', TODAY)).resolves.toBeTruthy();
  });

  it('does not take a first sick day ahead of time or from long ago', async () => {
    await expect(reportSick(db, 'emp_ann', { startDate: '2026-03-19' }, 'user_ann', TODAY)).rejects.toThrow(HrValidationError);
    await expect(reportSick(db, 'emp_ann', { startDate: '2026-02-01' }, 'user_ann', TODAY)).rejects.toThrow(HrValidationError);
  });
});

describe('recoverAbsence', () => {
  it('closes the report on the last sick day', async () => {
    const open = await reportSick(db, 'emp_ann', { startDate: '2026-03-16' }, 'user_ann', TODAY);

    const row = await recoverAbsence(db, open.id, '2026-03-17', 'user_ann', 'emp_ann', TODAY);

    expect(row).toMatchObject({ endDate: '2026-03-17', recoveredReportedBy: 'user_ann' });
    expect(row.recoveredReportedAt).toBeInstanceOf(Date);
    await expect(recoverAbsence(db, open.id, '2026-03-17', 'user_ann', 'emp_ann', TODAY)).rejects.toThrow(HrConflictError);
  });

  it('hides another employee\'s report from self-service', async () => {
    const open = await reportSick(db, 'emp_ann', { startDate: '2026-03-16' }, 'user_ann', TODAY);

    await expect(recoverAbsence(db, open.id, '2026-03-17', 'user_ben', 'emp_ben', TODAY)).rejects.toThrow(HrNotFoundError);
  });

  it('rejects a last sick day before the first, and a future one from the employee', async () => {
    const open = await reportSick(db, 'emp_ann', { startDate: '2026-03-16' }, 'user_ann', TODAY);

    await expect(recoverAbsence(db, open.id, '2026-03-13', 'user_ann', 'emp_ann', TODAY)).rejects.toThrow(HrValidationError);
    await expect(recoverAbsence(db, open.id, '2026-03-20', 'user_ann', 'emp_ann', TODAY)).rejects.toThrow(HrValidationError);
    // HR may know the return date in advance.
    await expect(recoverAbsence(db, open.id, '2026-03-20', 'user_hr', undefined, TODAY)).resolves.toMatchObject({ endDate: '2026-03-20' });
  });
});

describe('createAbsence and updateAbsence', () => {
  it('lets HR file a closed report on an employee\'s behalf', async () => {
    const row = await createAbsence(db, { employeeId: 'emp_ben', startDate: '2026-03-02', endDate: '2026-03-04' }, 'user_hr');

    expect(row).toMatchObject({ firstDay: 'full', endDate: '2026-03-04', reportedBy: 'user_hr', recoveredReportedBy: 'user_hr' });
  });

  it('refuses overlapping reports and unknown employees', async () => {
    await createAbsence(db, { employeeId: 'emp_ben', startDate: '2026-03-02', endDate: '2026-03-04' }, 'user_hr');

    await expect(createAbsence(db, { employeeId: 'emp_ben', startDate: '2026-03-04', endDate: '2026-03-06' }, 'user_hr')).rejects.toThrow(HrConflictError);
    await expect(createAbsence(db, { employeeId: 'emp_ben', startDate: '2026-02-27' }, 'user_hr')).rejects.toThrow(HrConflictError);
    await expect(createAbsence(db, { employeeId: 'emp_ben', startDate: '2026-03-05', endDate: '2026-03-06' }, 'user_hr')).resolves.toBeTruthy();
    await expect(createAbsence(db, { employeeId: 'emp_deleted', startDate: TODAY }, 'user_hr')).rejects.toThrow(HrNotFoundError);
  });

  it('corrects the dates and reopens a report closed by mistake', async () => {
    const row = await createAbsence(db, { employeeId: 'emp_ben', startDate: '2026-03-02', endDate: '2026-03-04' }, 'user_hr');

    const corrected = await updateAbsence(db, row.id, { startDate: '2026-03-03', firstDay: 'half' }, 'user_hr');
    expect(corrected).toMatchObject({ startDate: '2026-03-03', endDate: '2026-03-04', firstDay: 'half', recoveredReportedBy: 'user_hr' });

    const reopened = await updateAbsence(db, row.id, { endDate: null }, 'user_hr');
    expect(reopened).toMatchObject({ endDate: null, recoveredReportedBy: null, recoveredReportedAt: null });

    await expect(updateAbsence(db, row.id, { endDate: '2026-03-01' }, 'user_hr')).rejects.toThrow(HrValidationError);
  });
});

describe('listAbsences', () => {
  beforeEach(async () => {
    // Ann: sick 2–4 March, and again from the 16th, less than four weeks later.
    await createAbsence(db, { employeeId: 'emp_ann', startDate: '2026-03-02', endDate: '2026-03-04' }, 'user_hr');
    await reportSick(db, 'emp_ann', { startDate: '2026-03-16' }, 'user_ann', TODAY);
    // Ben: one closed report in January.
    await createAbsence(db, { employeeId: 'emp_ben', startDate: '2026-01-12', endDate: '2026-01-13' }, 'user_hr');
  });

  it('splits ongoing from completed', async () => {
    const ongoing = await listAbsences(db, { status: 'ongoing' }, TODAY);
    const completed = await listAbsences(db, { status: 'completed' }, TODAY);

    expect(ongoing.data.map((row) => [row.employeeName, row.startDate, row.status, row.days])).toEqual([
      ['Ann Adams', '2026-03-16', 'ongoing', 3],
    ]);
    expect(completed.data.map((row) => [row.employeeName, row.startDate, row.days])).toEqual([
      ['Ann Adams', '2026-03-02', 3],
      ['Ben Baker', '2026-01-12', 2],
    ]);
    expect(completed.totalCount).toBe(2);
  });

  it('says who filed the report and flags a relapse within four weeks', async () => {
    const all = await listAbsences(db, {}, TODAY);

    expect(all.data.map((row) => [row.startDate, row.relapse, row.reportedBySelf, row.reportedByName, row.departmentName])).toEqual([
      ['2026-03-16', true, true, null, 'Support'],
      ['2026-03-02', false, false, 'Hanna HR', 'Support'],
      ['2026-01-12', false, false, 'Hanna HR', null],
    ]);
  });

  it('filters by employee and department, and pages with a cursor', async () => {
    expect((await listAbsences(db, { employeeId: 'emp_ben' }, TODAY)).data).toHaveLength(1);
    expect((await listAbsences(db, { departmentId: 'dep_support' }, TODAY)).data).toHaveLength(2);

    const first = await listAbsences(db, { limit: 2 }, TODAY);
    expect(first).toMatchObject({ hasMore: true, totalCount: 3 });
    const second = await listAbsences(db, { limit: 2, cursor: first.cursor ?? undefined }, TODAY);
    expect(second.data.map((row) => row.startDate)).toEqual(['2026-01-12']);
    expect(second.hasMore).toBe(false);
  });

  it('removes a report', async () => {
    const [row] = (await listAbsences(db, { employeeId: 'emp_ben' }, TODAY)).data;
    await deleteAbsence(db, row!.id);

    expect((await listAbsences(db, { employeeId: 'emp_ben' }, TODAY)).data).toEqual([]);
    await expect(deleteAbsence(db, row!.id)).rejects.toThrow(HrNotFoundError);
  });
});

describe('employeeAbsences', () => {
  it('returns the open report and the history, without who filed them', async () => {
    await createAbsence(db, { employeeId: 'emp_ann', startDate: '2026-03-02', endDate: '2026-03-04', note: 'Flu' }, 'user_hr');
    await reportSick(db, 'emp_ann', { startDate: '2026-03-17' }, 'user_ann', TODAY);

    const mine = await employeeAbsences(db, 'emp_ann', TODAY);

    expect(mine.current).toMatchObject({ startDate: '2026-03-17', endDate: null, status: 'ongoing', days: 2 });
    expect(mine.history).toHaveLength(1);
    expect(mine.history[0]).toMatchObject({ startDate: '2026-03-02', endDate: '2026-03-04', status: 'completed', days: 3 });
    expect(mine.history[0]).not.toHaveProperty('reportedBy');
    expect((await employeeAbsences(db, 'emp_ben', TODAY)).current).toBeNull();
  });
});
