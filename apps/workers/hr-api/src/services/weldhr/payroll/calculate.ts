/**
 * Calculating a pay run: for every included employee build the engine's
 * `PayslipInput` from the database (compensation in force on the period end,
 * components overlapping the period, the run's inputs, the year-to-date
 * chain, the elections in force, the employer's rates), call the engine, and
 * store draft payslips with a snapshot of exactly what went in.
 *
 * The engine is a dependency (`deps.engines.calculatePayslip`): until a
 * country's engine lands it reports `unsupported_tax_year`, which becomes an
 * error issue on the payslip like any other engine error.
 *
 * Correction runs (kind `correction`) recalculate the corrected period with
 * the correction run's inputs and store only the difference (corrections.ts).
 */

import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { HrPayrollIssue, HrPayRunTotals } from '@weldsuite/db/schema';
import { nlAnnualWageForSpecialRewards, nlHolidayAllowanceBalance } from '@weldsuite/payroll-domain/nl';
import { PERIODS_PER_YEAR } from '@weldsuite/payroll-domain/periods';
import { toCents } from '@weldsuite/payroll-domain/money';
import type {
  ComponentInput,
  CompensationInput,
  NlPayslipInput,
  PayFrequency,
  PayPeriod,
  PayslipInput,
  PayslipResult,
  RunInput,
  UsPayslipInput,
  UsStateCertificateInput,
  UsW4Input,
} from '@weldsuite/payroll-domain/types';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { HrConflictError, HrNotFoundError } from '../shared';
import {
  num,
  pushIssue,
  sortIssues,
  type EmployerRow,
  type PayslipRow,
  type RunInputRow,
  type RunRow,
} from './common';
import {
  addTotals,
  correctionFrom,
  resultTotals,
  totalsToColumns,
  zeroTotals,
  type CorrectionBase,
  type TotalsCents,
} from './corrections';
import type { PayrollDeps } from './deps';
import {
  compensationOn,
  componentsOverlapping,
  electionOf,
  electionsInForce,
  loadEmployeePayrollData,
  readinessIssues,
  type EmployeePayrollData,
} from './employees';
import { employerIssues, readEmployerBank, workStatesOf } from './employers';
import { assertEditable, includedEmployeeIds, profileWindow, requireRun } from './runs';
import { carriedOverYtd, employeesWithFinalPayslips, finalPayslipsByEmployee, latestByApproval } from './ytd';

// ---------------------------------------------------------------------------
// The engine input
// ---------------------------------------------------------------------------

export function periodOf(run: Pick<RunRow, 'periodStart' | 'periodEnd' | 'payDate' | 'taxYear' | 'periodNumber'>, frequency: PayFrequency): PayPeriod {
  return {
    start: run.periodStart,
    end: run.periodEnd,
    payDate: run.payDate,
    frequency,
    taxYear: run.taxYear,
    periodNumber: run.periodNumber,
    periodsPerYear: PERIODS_PER_YEAR[frequency],
  };
}

function runInputsOf(rows: RunInputRow[]): RunInput[] {
  return rows.map((row) => ({
    code: row.code,
    label: row.label,
    quantity: num(row.quantity),
    rate: num(row.rate),
    amountCents: row.amount === null ? null : toCents(row.amount),
    workDate: row.workDate,
  }));
}

function toW4(data: Record<string, unknown>): UsW4Input {
  return {
    formYear: Number(data.formYear),
    filingStatus: data.filingStatus as UsW4Input['filingStatus'],
    multipleJobs: Boolean(data.multipleJobs),
    dependentsAmount: Number(data.dependentsAmount ?? 0),
    otherIncome: Number(data.otherIncome ?? 0),
    deductions: Number(data.deductions ?? 0),
    extraWithholding: Number(data.extraWithholding ?? 0),
    exempt: Boolean(data.exempt),
    allowances: data.allowances === undefined || data.allowances === null ? null : Number(data.allowances),
    nonresidentAlien: Boolean(data.nonresidentAlien),
  };
}

function toStateCertificate(data: Record<string, unknown>): UsStateCertificateInput {
  return {
    filingStatus: (data.filingStatus as string | null | undefined) ?? null,
    allowances: data.allowances === undefined || data.allowances === null ? null : Number(data.allowances),
    values: (data.values as UsStateCertificateInput['values'] | undefined) ?? {},
    extraWithholding: data.extraWithholding === undefined || data.extraWithholding === null ? null : Number(data.extraWithholding),
    exempt: Boolean(data.exempt),
  };
}

export interface BuildInputArgs {
  period: PayPeriod;
  employer: EmployerRow;
  data: EmployeePayrollData;
  inputs: RunInputRow[];
  /** Accumulators of the payslips before this one in the tax year. */
  ytd: Record<string, number>;
  /** NL: annual wage of the previous year; null in the first year of employment. */
  previousYearAnnualWageCents: number | null;
  /** NL: holiday allowance still owed from last year (the closing balance of last year's last payslip). */
  holidayAllowanceOpeningBalanceCents?: number | null;
  /** US: people on the employer's payroll, when the employer did not enter an estimate. */
  headcount: number;
}

/** Everything one payslip depends on, from the database rows. Compensation must exist. */
export function buildPayslipInput(args: BuildInputArgs): PayslipInput {
  const { period, employer, data, inputs, ytd } = args;
  const profile = data.profile!;
  const comp = compensationOn(data.compensations, period.end)!;
  const window = profileWindow(profile, data.employee);
  const compensation: CompensationInput = {
    payType: comp.payType as CompensationInput['payType'],
    amount: Number(comp.amount),
    period: comp.period as CompensationInput['period'],
    hoursPerWeek: comp.hoursPerWeek ?? profile.nl.contractHoursPerWeek ?? data.employee.weeklyHours ?? null,
  };
  const components: ComponentInput[] = componentsOverlapping(data.components, period.start, period.end).map((c) => ({
    code: c.code,
    label: c.label,
    amountCents: c.amount === null ? null : toCents(c.amount),
    params: c.params,
  }));
  const base = {
    period,
    employee: { dateOfBirth: data.sensitive.dateOfBirth ?? null, startDate: window.start, endDate: window.end },
    compensation,
    components,
    inputs: runInputsOf(inputs),
    ytd,
  };

  if (employer.country === 'NL') {
    const nlSettings = employer.nlSettings;
    const year = nlSettings.years?.[String(period.taxYear)];
    const nl = profile.nl;
    const contractHours = nl.contractHoursPerWeek ?? data.employee.weeklyHours ?? null;
    const election = electionOf(data.elections, period.end, 'nl_loonheffingskorting');
    const expat = nl.expatRuling && nl.expatRuling.from <= period.end && (!nl.expatRuling.to || nl.expatRuling.to >= period.start) ? nl.expatRuling.percent : null;
    const isDga = nl.isDga ?? false;
    const input: NlPayslipInput = {
      ...base,
      country: 'NL',
      employer: {
        whkRatePercent: year?.whkRate ?? null,
        sectorCode: nlSettings.sectorCode ?? null,
        aofSmallEmployer: year?.aofSmallEmployer ?? true,
        holidayAllowancePercent: nlSettings.holidayAllowancePercent ?? 8,
        holidayAllowancePayoutMonth: nlSettings.holidayAllowancePayoutMonth ?? null,
      },
      nl: {
        // No election means no credit: the employee settles it in their return.
        applyLoonheffingskorting: Boolean((election?.data as { applyCredit?: boolean } | undefined)?.applyCredit),
        // Handboek 2.6: without a BSN or a verified ID the 52% anonymous rate applies.
        anonymous: !data.sensitive.nationalId || !data.sensitive.idVerifiedAt,
        isDga,
        insuredWw: nl.insuredWw ?? !isDga,
        insuredZw: nl.insuredZw ?? !isDga,
        insuredWao: nl.insuredWao ?? !isDga,
        writtenContract: nl.writtenContract ?? false,
        indefiniteContract: nl.indefiniteContract ?? false,
        onCall: nl.onCall ?? false,
        contractHoursPerWeek: nl.contractHoursPerWeek ?? data.employee.weeklyHours ?? null,
        expatRulingPercent: expat,
        previousYearAnnualWageCents: args.previousYearAnnualWageCents,
        holidayAllowanceOpeningBalanceCents: args.holidayAllowanceOpeningBalanceCents ?? null,
        // Prorates a partial first or last month; a contract of 36 hours or more is a five-day week.
        usualWorkDaysPerWeek: nl.usualWorkDaysPerWeek ?? (contractHours !== null && contractHours < 36 ? 4 : 5),
      },
    };
    return input;
  }

  const usSettings = employer.usSettings;
  const year = String(period.taxYear);
  const suiRatePercent: Record<string, number | null> = {};
  const extraRates: Record<string, Record<string, number>> = {};
  for (const [state, config] of Object.entries(usSettings.states ?? {})) {
    suiRatePercent[state] = config.suiRates?.[year] ?? null;
    extraRates[state] = config.extraRates?.[year] ?? {};
  }
  const workState = profile.us.workState ?? null;
  if (workState && !(workState in suiRatePercent)) suiRatePercent[workState] = null;
  const w4 = electionOf(data.elections, period.end, 'us_w4');
  const stateCertificates: Record<string, UsStateCertificateInput> = {};
  for (const election of electionsInForce(data.elections, period.end)) {
    if (election.kind === 'us_state_certificate' && election.state) {
      stateCertificates[election.state] = toStateCertificate(election.data as unknown as Record<string, unknown>);
    }
  }
  const input: UsPayslipInput = {
    ...base,
    country: 'US',
    employer: {
      workweekStartDay: usSettings.workweekStartDay ?? 0,
      suiRatePercent,
      extraRates,
      employeeCountEstimate: usSettings.employeeCountEstimate ?? args.headcount,
    },
    us: {
      workState,
      residenceState: profile.us.residenceState ?? null,
      // Hourly employees are non-exempt unless HR says otherwise; salaried employees exempt.
      flsaStatus: profile.us.flsaStatus ?? (comp.payType === 'hourly' ? 'nonexempt' : 'exempt'),
      w4: w4 ? toW4(w4.data as unknown as Record<string, unknown>) : null,
      stateCertificates,
      exemptFica: profile.us.exemptFica ?? false,
      exemptFuta: profile.us.exemptFuta ?? false,
      statutoryEmployee: profile.us.statutoryEmployee ?? false,
      retirementPlan: profile.us.retirementPlan ?? false,
    },
  };
  return input;
}

/** The engine never throws by contract; if one does, it is an error on that payslip, not a failed run. */
export function safeCalculate(deps: PayrollDeps, input: PayslipInput): PayslipResult {
  try {
    return deps.engines.calculatePayslip(input);
  } catch (err) {
    const empty: PayslipResult = {
      lines: [],
      grossCents: 0,
      taxableWageCents: 0,
      employeeTaxesCents: 0,
      employeeDeductionsCents: 0,
      reimbursementsCents: 0,
      netCents: 0,
      employerTaxesCents: 0,
      employerCostCents: 0,
      ytd: { ...input.ytd },
      filingData: (input.country === 'NL'
        ? { kind: 'nl' }
        : { kind: 'us', federal: {}, states: {}, qualifiedOvertimePremium: 0, hoursWorked: 0 }) as unknown as PayslipResult['filingData'],
      issues: [
        {
          severity: 'error',
          code: 'unsupported_tax_year',
          params: { year: input.period.taxYear, message: err instanceof Error ? err.message.slice(0, 200) : 'engine error' },
        },
      ],
      ruleSet: 'engine-error',
    };
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Calculate a run
// ---------------------------------------------------------------------------

interface StoredPayslip {
  employeeId: string;
  values: typeof schema.hrPayslips.$inferInsert;
  totals: TotalsCents;
}

function asIssues(employeeId: string, issues: PayslipResult['issues']): HrPayrollIssue[] {
  return issues.map((i) => ({ severity: i.severity, code: i.code, employeeId, ...(i.params ? { params: i.params } : {}) }));
}

function aggregateTotals(slips: StoredPayslip[]): HrPayRunTotals {
  let t = zeroTotals();
  for (const s of slips) t = addTotals(t, s.totals);
  return {
    grossCents: t.grossCents,
    netCents: t.netCents,
    employeeTaxesCents: t.employeeTaxesCents,
    employeeDeductionsCents: t.employeeDeductionsCents,
    employerTaxesCents: t.employerTaxesCents,
    reimbursementsCents: t.reimbursementsCents,
    employerCostCents: t.employerCostCents,
  };
}

export async function calculateRun(db: Database, runId: string, deps: PayrollDeps, ctx: { userId: string }): Promise<RunRow> {
  let run = await requireRun(db, runId);
  assertEditable(run);
  const employer = await db
    .select()
    .from(schema.hrPayrollEmployers)
    .where(eq(schema.hrPayrollEmployers.id, run.employerId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!employer) throw new HrNotFoundError('Payroll employer', run.employerId);

  // While the run is being (re)calculated it is a draft: an approval cannot start on a half-written calculation, and
  // a run that was approved or cancelled in the meantime is left alone (409).
  await claimForCalculation(db, runId);
  run = await requireRun(db, runId);

  const included = await includedEmployeeIds(db, run);
  // Taken before the data is read: a change in between only makes the run look stale, never fresh.
  const version = await dataVersion(db, employer.id, included);
  const inputsStamp = await runInputsStamp(db, runId);
  const data = await loadEmployeePayrollData(db, included, deps.keyring);
  const inputRows = included.length
    ? await db.select().from(schema.hrPayRunInputs).where(and(eq(schema.hrPayRunInputs.runId, runId), inArray(schema.hrPayRunInputs.employeeId, included)))
    : [];
  const inputsOf = (employeeId: string) => inputRows.filter((x) => x.employeeId === employeeId);

  const scheduleIds = [...new Set([run.payScheduleId, ...[...data.values()].map((d) => d.profile?.payScheduleId)].filter((v): v is string => Boolean(v)))];
  const schedules = scheduleIds.length
    ? await db.select({ id: schema.hrPaySchedules.id, frequency: schema.hrPaySchedules.frequency }).from(schema.hrPaySchedules).where(inArray(schema.hrPaySchedules.id, scheduleIds))
    : [];
  const frequencyOfSchedule = new Map(schedules.map((s) => [s.id, s.frequency as PayFrequency]));
  const frequencyFor = (d: EmployeePayrollData): PayFrequency =>
    (run.payScheduleId && frequencyOfSchedule.get(run.payScheduleId)) ||
    (d.profile?.payScheduleId && frequencyOfSchedule.get(d.profile.payScheduleId)) ||
    'monthly';

  const issues: HrPayrollIssue[] = [];
  const slips: StoredPayslip[] = [];

  if (run.kind === 'correction') {
    await calculateCorrections(db, run, employer, included, data, inputsOf, deps, issues, slips, frequencyFor);
  } else {
    const chain = await finalPayslipsByEmployee(db, included, employer.id, run.taxYear);
    // Last year's chain: NL reads the annual wage for the special-reward table, US carries open overtime workweeks.
    const previousYear = await finalPayslipsByEmployee(db, included, employer.id, run.taxYear - 1);
    const everPaid = await employeesWithFinalPayslips(db, included, employer.id);
    const previousNets = await previousFinalNets(db, run, included);

    for (const employeeId of included) {
      const d = data.get(employeeId);
      if (!d || !d.profile || !d.employer) {
        issues.push({ severity: 'error', code: 'employer_incomplete', employeeId, params: { field: 'payroll_profile' } });
        continue;
      }
      const readiness = readinessIssues(d, { onDate: run.periodEnd, scope: 'run' });
      for (const issue of readiness) pushIssue(issues, issue);
      if (readiness.some((i) => i.code === 'missing_compensation')) continue;

      const tip = latestByApproval(chain.get(employeeId) ?? []);
      const lastYearTip = latestByApproval(previousYear.get(employeeId) ?? []);
      const input = buildPayslipInput({
        period: periodOf(run, frequencyFor(d)),
        employer,
        data: d,
        inputs: inputsOf(employeeId),
        ytd: tip ? tip.ytd : employer.country === 'US' ? carriedOverYtd(lastYearTip) : {},
        previousYearAnnualWageCents: employer.country === 'NL' && lastYearTip ? nlAnnualWageForSpecialRewards(lastYearTip.ytd) : null,
        holidayAllowanceOpeningBalanceCents: employer.country === 'NL' && lastYearTip ? nlHolidayAllowanceBalance(lastYearTip.ytd) : null,
        headcount: included.length,
      });
      const result = safeCalculate(deps, input);
      const employeeIssues = asIssues(employeeId, result.issues);
      for (const issue of readiness) if (!employeeIssues.some((i) => i.code === issue.code)) employeeIssues.push(issue);

      if (!everPaid.has(employeeId)) employeeIssues.push({ severity: 'warning', code: 'first_payslip', employeeId });
      const previous = previousNets.get(employeeId);
      if (run.kind === 'regular' && previous && previous > 0) {
        const change = Math.abs(result.netCents - previous) / previous;
        if (change > 0.2) {
          employeeIssues.push({ severity: 'warning', code: 'large_change', employeeId, params: { percent: Math.round(change * 100) } });
        }
      }
      for (const issue of employeeIssues) pushIssue(issues, issue);

      slips.push({
        employeeId,
        totals: resultTotals(result),
        values: {
          id: generateId('hrps'),
          runId,
          employeeId,
          employerId: employer.id,
          country: run.country,
          currency: run.currency,
          status: 'draft',
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          payDate: run.payDate,
          taxYear: run.taxYear,
          periodNumber: run.periodNumber,
          ...totalsToColumns(resultTotals(result)),
          lines: result.lines,
          ytd: result.ytd,
          filingData: result.filingData as unknown as Record<string, unknown>,
          // The year-to-date chain this payslip continues: approval refuses it once another payslip was approved after
          // the one it started from (`chain`), or anything else it read changed (`dataVersion`, `inputsStamp`).
          snapshot: {
            input,
            ruleSet: result.ruleSet,
            dataVersion: '',
            inputsStamp: '',
            chain: { tipId: tip?.id ?? null, previousYearTipId: lastYearTip?.id ?? null },
          },
          issues: sortIssues(employeeIssues),
          correctsPayslipId: null,
        },
      });
    }
  }

  for (const slip of slips) {
    const snapshot = slip.values.snapshot as Record<string, unknown>;
    snapshot.dataVersion = version;
    snapshot.inputsStamp = inputsStamp;
  }

  // Run-level checks: the employer once for the whole run.
  const bank = await readEmployerBank(employer, deps.keyring);
  const states = workStatesOf([...data.values()].filter((d) => d.profile).map((d) => ({ us: d.profile!.us })));
  for (const issue of employerIssues(employer, bank, states, run.taxYear)) pushIssue(issues, issue);

  const now = new Date();
  const kept = slips.map((s) => s.employeeId);
  const s = schema.hrPayslips;
  await atomically(db, (h) => [
    // Draft payslips of people who are no longer in the run (or no longer produce one) go.
    kept.length
      ? h.delete(s).where(and(eq(s.runId, runId), eq(s.status, 'draft'), notInArray(s.employeeId, kept)))
      : h.delete(s).where(and(eq(s.runId, runId), eq(s.status, 'draft'))),
    ...slips.map((slip) =>
      h
        .insert(s)
        .values(slip.values)
        .onConflictDoUpdate({
          target: [s.runId, s.employeeId],
          // Only a draft is rewritten: a final payslip is never touched by a calculation.
          setWhere: eq(s.status, 'draft'),
          set: {
            employerId: slip.values.employerId,
            country: slip.values.country,
            currency: slip.values.currency,
            periodStart: slip.values.periodStart,
            periodEnd: slip.values.periodEnd,
            payDate: slip.values.payDate,
            taxYear: slip.values.taxYear,
            periodNumber: slip.values.periodNumber,
            grossPay: slip.values.grossPay,
            taxableWage: slip.values.taxableWage,
            employeeTaxes: slip.values.employeeTaxes,
            employeeDeductions: slip.values.employeeDeductions,
            reimbursements: slip.values.reimbursements,
            netPay: slip.values.netPay,
            employerTaxes: slip.values.employerTaxes,
            employerCost: slip.values.employerCost,
            lines: slip.values.lines,
            ytd: slip.values.ytd,
            filingData: slip.values.filingData,
            snapshot: slip.values.snapshot,
            issues: slip.values.issues,
            correctsPayslipId: slip.values.correctsPayslipId,
            updatedAt: now,
          },
        }),
    ),
  ]);
  // Calculated only now that every payslip is written, and only if the run is still the draft we claimed.
  const done = await db
    .update(schema.hrPayRuns)
    .set({
      status: 'calculated',
      calculatedBy: ctx.userId,
      calculatedAt: now,
      totals: aggregateTotals(slips),
      issues: sortIssues(issues),
      employeeCount: slips.length,
      updatedAt: now,
    })
    .where(and(eq(schema.hrPayRuns.id, runId), eq(schema.hrPayRuns.status, 'draft')))
    .returning({ id: schema.hrPayRuns.id });
  if (done.length === 0) {
    // Cancelled while it was being calculated: leave no draft payslips behind.
    await db.delete(s).where(and(eq(s.runId, runId), eq(s.status, 'draft')));
    throw new HrConflictError('This pay run was cancelled or changed while it was being calculated. Reload it and try again.');
  }
  return requireRun(db, runId);
}

/** draft | calculated → draft, or 409 when the run was approved, paid or cancelled. */
async function claimForCalculation(db: Database, runId: string): Promise<void> {
  const r = schema.hrPayRuns;
  const rows = await db
    .update(r)
    .set({ status: 'draft', updatedAt: new Date() })
    .where(and(eq(r.id, runId), inArray(r.status, ['draft', 'calculated'])))
    .returning({ id: r.id });
  if (rows.length === 0) throw new HrConflictError('This pay run was approved, cancelled or changed by someone else. Reload it and try again.');
}

/**
 * A marker of the run's own inputs: how many there are and when the latest was
 * created or edited. Stored in each draft payslip's snapshot; approval compares
 * it, so an input added, edited or removed while the run was being calculated
 * (or after) shows up as a stale calculation.
 */
export async function runInputsStamp(db: Database, runId: string): Promise<string> {
  const i = schema.hrPayRunInputs;
  const rows = await db.select({ createdAt: i.createdAt, updatedAt: i.updatedAt }).from(i).where(eq(i.runId, runId));
  let latest = '';
  for (const row of rows) {
    for (const at of [row.createdAt, row.updatedAt]) {
      const iso = at.toISOString();
      if (iso > latest) latest = iso;
    }
  }
  return `${rows.length}|${latest}`;
}

/** Net pay (cents) of each employee's previous final, non-correction payslip at the employer. */
async function previousFinalNets(db: Database, run: RunRow, employeeIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (employeeIds.length === 0) return out;
  const s = schema.hrPayslips;
  const rows = await db
    .select({ employeeId: s.employeeId, netPay: s.netPay, periodEnd: s.periodEnd, correctsPayslipId: s.correctsPayslipId, runId: s.runId })
    .from(s)
    .where(and(inArray(s.employeeId, employeeIds), eq(s.employerId, run.employerId), eq(s.status, 'final')));
  const candidates = rows.filter((x) => !x.correctsPayslipId && x.runId !== run.id && x.periodEnd < run.periodEnd);
  candidates.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
  for (const row of candidates) if (!out.has(row.employeeId)) out.set(row.employeeId, toCents(row.netPay));
  return out;
}

// ---------------------------------------------------------------------------
// Correction runs
// ---------------------------------------------------------------------------

async function calculateCorrections(
  db: Database,
  run: RunRow,
  employer: EmployerRow,
  included: string[],
  data: Map<string, EmployeePayrollData>,
  inputsOf: (employeeId: string) => RunInputRow[],
  deps: PayrollDeps,
  issues: HrPayrollIssue[],
  slips: StoredPayslip[],
  frequencyFor: (d: EmployeePayrollData) => PayFrequency,
): Promise<void> {
  if (!run.correctsRunId) throw new HrConflictError('This correction run does not say which run it corrects');
  const s = schema.hrPayslips;
  const originals = await db.select().from(s).where(and(eq(s.runId, run.correctsRunId), eq(s.status, 'final')));
  const originalOf = new Map(originals.map((o) => [o.employeeId, o]));
  const allCorrections = originals.length
    ? await db.select().from(s).where(and(inArray(s.correctsPayslipId, originals.map((o) => o.id)), eq(s.status, 'final')))
    : [];

  // The people the run pays: those it was created for, minus the ones left out of it.
  for (const employeeId of included) {
    const original = originalOf.get(employeeId);
    const d = data.get(employeeId);
    if (!original || !d || !d.profile || !d.employer) {
      issues.push({ severity: 'error', code: 'employer_incomplete', employeeId, params: { field: 'payroll_profile' } });
      continue;
    }
    const readiness = readinessIssues(d, { onDate: run.periodEnd, scope: 'run' });
    for (const issue of readiness) pushIssue(issues, issue);
    if (readiness.some((i) => i.code === 'missing_compensation')) continue;

    // The year's chain as it stands: the recalculation starts from the accumulators the original started from, plus
    // what corrections of EARLIER periods changed since (they move cumulative bases such as wage caps and accruals).
    const chain = await finalPayslipsByEmployee(db, [employeeId], employer.id, original.taxYear);
    const chainRows = chain.get(employeeId) ?? [];
    const tip = latestByApproval(chainRows);

    const originalInput = (original.snapshot as { input?: PayslipInput }).input;
    const ytdBefore: Record<string, number> = { ...(originalInput?.ytd ?? {}) };
    for (const row of chainRows) {
      const corrected = row.correctsPayslipId ? chainRows.find((x) => x.id === row.correctsPayslipId) : null;
      if (!corrected || corrected.periodEnd >= original.periodEnd) continue;
      for (const [key, value] of Object.entries((row.snapshot as { ytdDelta?: Record<string, number> }).ytdDelta ?? {})) {
        ytdBefore[key] = (ytdBefore[key] ?? 0) + value;
      }
    }
    const previousYearAnnualWageCents =
      originalInput && originalInput.country === 'NL' ? originalInput.nl.previousYearAnnualWageCents : null;
    // The recalculation sits in the original's period and tax year; only the run's inputs are new.
    const period: PayPeriod = { ...periodOf({ ...run, payDate: original.payDate, taxYear: original.taxYear }, frequencyFor(d)) };
    const input = buildPayslipInput({
      period,
      employer,
      data: d,
      inputs: inputsOf(employeeId),
      ytd: ytdBefore,
      previousYearAnnualWageCents,
      holidayAllowanceOpeningBalanceCents: originalInput && originalInput.country === 'NL' ? originalInput.nl.holidayAllowanceOpeningBalanceCents ?? null : null,
      headcount: run.includedEmployeeIds?.length ?? 1,
    });
    const result = safeCalculate(deps, input);
    const base: CorrectionBase = {
      original,
      corrections: allCorrections
        .filter((c) => c.correctsPayslipId === original.id)
        .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '')),
    };
    const diff = correctionFrom(result, ytdBefore, base);

    const tipYtd = tip?.ytd ?? original.ytd;
    const ytd: Record<string, number> = { ...tipYtd };
    for (const [key, value] of Object.entries(diff.ytdDelta)) ytd[key] = (ytd[key] ?? 0) + value;

    const employeeIssues = asIssues(employeeId, result.issues);
    for (const issue of readiness) if (!employeeIssues.some((i) => i.code === issue.code)) employeeIssues.push(issue);
    for (const issue of employeeIssues) pushIssue(issues, issue);

    slips.push({
      employeeId,
      totals: diff.totals,
      values: {
        id: generateId('hrps'),
        runId: run.id,
        employeeId,
        employerId: employer.id,
        country: run.country,
        currency: run.currency,
        status: 'draft',
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        // The difference is paid on the correction run's pay date.
        payDate: run.payDate,
        taxYear: original.taxYear,
        periodNumber: run.periodNumber,
        ...totalsToColumns(diff.totals),
        lines: diff.lines,
        ytd,
        filingData: diff.filingData,
        snapshot: {
          kind: 'correction',
          dataVersion: '',
          inputsStamp: '',
          chain: { tipId: tip?.id ?? null, previousYearTipId: null },
          input,
          ruleSet: result.ruleSet,
          ytdDelta: diff.ytdDelta,
          originalNumber: original.number,
          recalculated: resultTotals(result),
        },
        issues: sortIssues(employeeIssues),
        correctsPayslipId: original.id,
      },
    });
  }
}

/**
 * A marker of everything payroll reads for these employees and the employer:
 * the latest change time across the employer, the employees, their profiles,
 * compensation, components and tax elections, from the database's own clock.
 * A calculation stores it in its snapshot; approving compares it with the
 * current one, so a change after the calculation is detected without comparing
 * database time with this worker's clock.
 */
export async function dataVersion(db: Database, employerId: string, employeeIds: string[]): Promise<string> {
  const checks: Array<Promise<Array<{ at: Date | null }>>> = [
    db.select({ at: schema.hrPayrollEmployers.updatedAt }).from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, employerId)),
  ];
  if (employeeIds.length) {
    checks.push(
      db.select({ at: schema.hrEmployees.updatedAt }).from(schema.hrEmployees).where(inArray(schema.hrEmployees.id, employeeIds)),
      db.select({ at: schema.hrPayrollProfiles.updatedAt }).from(schema.hrPayrollProfiles).where(inArray(schema.hrPayrollProfiles.employeeId, employeeIds)),
      db.select({ at: schema.hrCompensations.updatedAt }).from(schema.hrCompensations).where(inArray(schema.hrCompensations.employeeId, employeeIds)),
      db.select({ at: schema.hrPayComponents.updatedAt }).from(schema.hrPayComponents).where(inArray(schema.hrPayComponents.employeeId, employeeIds)),
      db.select({ at: schema.hrTaxElections.createdAt }).from(schema.hrTaxElections).where(inArray(schema.hrTaxElections.employeeId, employeeIds)),
    );
  }
  let latest = '';
  for (const rows of await Promise.all(checks)) {
    for (const row of rows) {
      const iso = row.at ? row.at.toISOString() : '';
      if (iso > latest) latest = iso;
    }
  }
  return latest;
}
