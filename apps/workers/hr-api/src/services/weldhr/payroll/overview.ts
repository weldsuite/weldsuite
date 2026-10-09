/**
 * The payroll landing page: employers and their issues, whether setup is
 * complete, the next period of each schedule, recent runs and filings due.
 */

import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { HrPayrollOverview } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { listPayrollEmployees } from './employees';
import { listEmployers } from './employers';
import { filingsDueSoon } from './filings';
import { toRunDtos } from './runs';
import { listSchedules } from './schedules';

export async function payrollOverview(
  db: Database,
  keyring: EncryptionKeyring,
  opts: { today: string; digipoortAvailable: boolean },
): Promise<HrPayrollOverview> {
  const employers = (await listEmployers(db, keyring)).filter((e) => e.isActive);
  const employerById = new Map(employers.map((e) => [e.id, e]));
  const schedules = (await listSchedules(db)).filter((x) => x.isActive && employerById.has(x.employerId));
  const onPayroll = await listPayrollEmployees(db, { onPayroll: true }, keyring, opts.today);

  // The live regular run of each upcoming period, if one exists.
  const r = schema.hrPayRuns;
  const scheduleIds = schedules.map((x) => x.id);
  const liveRuns = scheduleIds.length
    ? await db
        .select({ id: r.id, scheduleId: r.payScheduleId, periodStart: r.periodStart, status: r.status })
        .from(r)
        .where(and(inArray(r.payScheduleId, scheduleIds), eq(r.kind, 'regular'), ne(r.status, 'cancelled')))
    : [];

  const upcoming: HrPayrollOverview['upcoming'] = [];
  for (const schedule of schedules) {
    if (!schedule.nextPeriod) continue;
    const employer = employerById.get(schedule.employerId)!;
    const run = liveRuns.find((x) => x.scheduleId === schedule.id && x.periodStart === schedule.nextPeriod!.start);
    upcoming.push({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      employerId: employer.id,
      employerName: employer.name,
      country: employer.country,
      period: schedule.nextPeriod,
      runId: run?.id ?? null,
      runStatus: (run?.status as HrPayrollOverview['upcoming'][number]['runStatus']) ?? null,
    });
  }
  upcoming.sort((a, b) => a.period.payDate.localeCompare(b.period.payDate));

  const recent = await db.select().from(r).where(ne(r.status, 'cancelled')).orderBy(desc(r.periodStart), desc(r.createdAt)).limit(6);

  return {
    employers: employers.map((e) => ({ id: e.id, name: e.name, country: e.country, employeeCount: e.employeeCount, issues: e.issues })),
    setup: {
      hasEmployer: employers.length > 0,
      hasSchedule: schedules.length > 0,
      employeesOnPayroll: onPayroll.length,
      employeesNotReady: onPayroll.filter((e) => e.issues.some((i) => i.severity === 'error')).length,
    },
    upcoming,
    recentRuns: await toRunDtos(db, recent),
    filingsDue: await filingsDueSoon(db, opts.today, opts.digipoortAvailable),
  };
}

