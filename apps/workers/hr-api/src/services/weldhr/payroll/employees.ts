/**
 * Payroll setup per employee: the payroll profile, effective-dated
 * compensation, recurring pay components, signed tax elections, and the
 * identity and bank details that live in the employee's encrypted sensitive
 * block. Also the readiness checks ("can this person be paid?").
 */

import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { decryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { HrEmployeeSensitive, HrPayrollIssue } from '@weldsuite/db/schema';
import { componentDef } from '@weldsuite/payroll-domain';
import { stateModule } from '@weldsuite/payroll-domain/us/states';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { atomically } from '@weldsuite/worker-kit/atomically';
import type {
  CreateHrCompensationInput,
  CreateHrPayComponentInput,
  CreateHrTaxElectionInput,
  HrPayrollPaymentDetailsInput,
  UpdateHrPayComponentInput,
  UpsertHrPayrollProfileInput,
} from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import type {
  HrMyPayrollDetails,
  HrStateCertificateDefinition,
  HrCompensation as CompensationDto,
  HrPayComponent as ComponentDto,
  HrPayrollEmployeeDetail,
  HrPayrollEmployeeListItem,
  HrPayrollPaymentDetailsMasked,
  HrPayrollProfile as ProfileDto,
  HrTaxElection as ElectionDto,
} from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { displayNameOf, requireEmployee, writeSensitive } from '../employees';
import { HrConflictError, HrNotFoundError, HrPayrollError, HrValidationError, assertDateOrder } from '../shared';
import {
  decimal2,
  decimal4,
  sortIssues,
  ts,
  type ComponentRow,
  type CompensationRow,
  type ElectionRow,
  type EmployeeRow,
  type EmployerRow,
  type ProfileRow,
} from './common';
import { addDays, ageOnDate, isIsoDate, rangesOverlap, todayIso } from './dates';
import { employerIssues, readEmployerBank, workStatesOf } from './employers';
import {
  isValidIban,
  isValidRoutingNumber,
  maskAccountNumber,
  maskIban,
  maskNationalId,
  normalizeBic,
  normalizeBsn,
  normalizeIban,
  normalizeSsn,
} from './validators';

// ---------------------------------------------------------------------------
// Everything payroll knows about one employee
// ---------------------------------------------------------------------------

export interface EmployeePayrollData {
  employee: EmployeeRow;
  profile: ProfileRow | null;
  employer: EmployerRow | null;
  sensitive: HrEmployeeSensitive;
  compensations: CompensationRow[];
  components: ComponentRow[];
  elections: ElectionRow[];
}

export async function decryptSensitive(row: Pick<EmployeeRow, 'sensitiveEncrypted'>, keyring: EncryptionKeyring): Promise<HrEmployeeSensitive> {
  if (!row.sensitiveEncrypted) return {};
  return JSON.parse(await decryptField(row.sensitiveEncrypted, keyring)) as HrEmployeeSensitive;
}

/** Load payroll data for a set of employees in a handful of queries. */
export async function loadEmployeePayrollData(
  db: Database,
  employeeIds: string[],
  keyring: EncryptionKeyring,
): Promise<Map<string, EmployeePayrollData>> {
  const out = new Map<string, EmployeePayrollData>();
  if (employeeIds.length === 0) return out;
  const e = schema.hrEmployees;
  const [employees, profiles, compensations, components, elections] = await Promise.all([
    db.select().from(e).where(and(inArray(e.id, employeeIds), isNull(e.deletedAt))),
    db.select().from(schema.hrPayrollProfiles).where(inArray(schema.hrPayrollProfiles.employeeId, employeeIds)),
    db
      .select()
      .from(schema.hrCompensations)
      .where(inArray(schema.hrCompensations.employeeId, employeeIds))
      .orderBy(desc(schema.hrCompensations.effectiveFrom)),
    db
      .select()
      .from(schema.hrPayComponents)
      .where(and(inArray(schema.hrPayComponents.employeeId, employeeIds), isNull(schema.hrPayComponents.deletedAt)))
      .orderBy(asc(schema.hrPayComponents.effectiveFrom)),
    db
      .select()
      .from(schema.hrTaxElections)
      .where(inArray(schema.hrTaxElections.employeeId, employeeIds))
      .orderBy(desc(schema.hrTaxElections.effectiveFrom), desc(schema.hrTaxElections.createdAt)),
  ]);
  const employerIds = [...new Set(profiles.map((p) => p.employerId))];
  const employers = employerIds.length
    ? await db.select().from(schema.hrPayrollEmployers).where(inArray(schema.hrPayrollEmployers.id, employerIds))
    : [];
  const employerById = new Map(employers.map((r) => [r.id, r]));
  const profileOf = new Map(profiles.map((p) => [p.employeeId, p]));

  for (const employee of employees) {
    const profile = profileOf.get(employee.id) ?? null;
    out.set(employee.id, {
      employee,
      profile,
      employer: profile ? employerById.get(profile.employerId) ?? null : null,
      sensitive: profile ? await decryptSensitive(employee, keyring) : {},
      compensations: compensations.filter((c) => c.employeeId === employee.id),
      components: components.filter((c) => c.employeeId === employee.id),
      elections: elections.filter((x) => x.employeeId === employee.id),
    });
  }
  return out;
}

export async function loadOneEmployeePayrollData(db: Database, employeeId: string, keyring: EncryptionKeyring): Promise<EmployeePayrollData> {
  const data = (await loadEmployeePayrollData(db, [employeeId], keyring)).get(employeeId);
  if (!data) throw new HrNotFoundError('Employee', employeeId);
  // Sensitive data is only needed (and decrypted) with a profile; payment-details reads want it regardless.
  if (!data.profile) data.sensitive = await decryptSensitive(data.employee, keyring);
  return data;
}

// ---------------------------------------------------------------------------
// Point-in-time lookups
// ---------------------------------------------------------------------------

/** The compensation in force on `date`: the latest one that started on or before it and had not ended. */
export function compensationOn(rows: CompensationRow[], date: string): CompensationRow | null {
  const sorted = [...rows].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
  for (const row of sorted) {
    if (row.effectiveFrom <= date && (row.effectiveTo === null || row.effectiveTo >= date)) return row;
  }
  return null;
}

/** Components that overlap [start, end]. */
export function componentsOverlapping(rows: ComponentRow[], start: string, end: string): ComponentRow[] {
  return rows.filter((row) => rangesOverlap(row.effectiveFrom, row.effectiveTo, start, end));
}

/** The election of each kind (and state) in force on `date`: newest start, then newest signature. */
export function electionsInForce(rows: ElectionRow[], date: string): ElectionRow[] {
  const best = new Map<string, ElectionRow>();
  for (const row of rows) {
    if (row.effectiveFrom > date) continue;
    const key = `${row.kind}|${row.state ?? ''}`;
    const current = best.get(key);
    if (!current || row.effectiveFrom > current.effectiveFrom || (row.effectiveFrom === current.effectiveFrom && row.createdAt > current.createdAt)) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

export function electionOf(rows: ElectionRow[], date: string, kind: string, state: string | null = null): ElectionRow | null {
  const wanted = state ? state.toUpperCase() : null;
  return electionsInForce(rows, date).find((r) => r.kind === kind && (r.state ? r.state.toUpperCase() : null) === wanted) ?? null;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/** Does the state have a withholding certificate the employee has to sign? */
export function stateCertificateRequired(state: string | null | undefined): boolean {
  return Boolean(stateModule(state)?.certificate);
}

/**
 * Can this person be paid? `list` is the employees screen (everything that
 * would stand in the way); `run` is a calculation, where the engine reports
 * the anonymous rate and the missing W-4 itself and the employer is checked
 * once for the whole run.
 */
export function readinessIssues(
  data: EmployeePayrollData,
  opts: { onDate: string; scope: 'list' | 'run'; employerIssues?: HrPayrollIssue[] },
): HrPayrollIssue[] {
  const { profile, employer, sensitive } = data;
  if (!profile || !employer || profile.status === 'ended') return [];
  const employeeId = data.employee.id;
  const issues: HrPayrollIssue[] = [];
  const add = (severity: 'error' | 'warning', code: string, params?: Record<string, string | number>) =>
    issues.push({ severity, code, employeeId, ...(params ? { params } : {}) });

  if (!compensationOn(data.compensations, opts.onDate)) add('error', 'missing_compensation');
  if (!sensitive.nationalId) add('error', 'missing_tax_id');

  if (employer.country === 'NL') {
    if (!sensitive.dateOfBirth) add('error', 'missing_date_of_birth');
    if (!sensitive.bankIban) add('error', 'missing_bank_account');
    if (opts.scope === 'list' && sensitive.nationalId && !sensitive.idVerifiedAt) add('warning', 'anonymous_rate', { reason: 'id_not_verified' });
    if (!electionOf(data.elections, opts.onDate, 'nl_loonheffingskorting')) {
      add('warning', 'missing_tax_election', { kind: 'nl_loonheffingskorting' });
    }
  } else {
    if (!sensitive.bankRoutingNumber || !sensitive.bankAccountNumber) add('error', 'missing_bank_account');
    const workState = profile.us.workState ?? null;
    if (!workState) add('error', 'missing_work_state');
    if (opts.scope === 'list' && !electionOf(data.elections, opts.onDate, 'us_w4')) {
      add('warning', 'missing_tax_election', { kind: 'us_w4' });
    }
    if (workState && stateCertificateRequired(workState) && !electionOf(data.elections, opts.onDate, 'us_state_certificate', workState)) {
      add('warning', 'missing_tax_election', { kind: 'us_state_certificate', state: workState });
    }
  }

  if (opts.scope === 'list') {
    const blocking = (opts.employerIssues ?? []).find((i) => i.severity === 'error');
    if (blocking) add('error', 'employer_incomplete', blocking.params);
  }
  return sortIssues(issues);
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export function toProfileDto(row: ProfileRow): ProfileDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employerId: row.employerId,
    payScheduleId: row.payScheduleId,
    status: row.status as ProfileDto['status'],
    startDate: row.startDate,
    endDate: row.endDate,
    nl: row.nl,
    us: row.us,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCompensationDto(row: CompensationRow): CompensationDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    payType: row.payType as CompensationDto['payType'],
    amount: row.amount,
    period: row.period as CompensationDto['period'],
    currency: row.currency,
    hoursPerWeek: row.hoursPerWeek,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toComponentDto(row: ComponentRow): ComponentDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    code: row.code,
    label: row.label,
    amount: row.amount,
    params: row.params,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toElectionDto(row: ElectionRow): ElectionDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind as ElectionDto['kind'],
    state: row.state ? row.state.toUpperCase() : null,
    effectiveFrom: row.effectiveFrom,
    data: row.data as unknown as Record<string, unknown>,
    signedBy: row.signedBy,
    signatureName: row.signatureName,
    signedAt: ts(row.signedAt),
    source: row.source as ElectionDto['source'],
    createdAt: row.createdAt.toISOString(),
  };
}

export function maskPaymentDetails(s: HrEmployeeSensitive): HrPayrollPaymentDetailsMasked {
  return {
    hasNationalId: Boolean(s.nationalId),
    nationalIdMasked: maskNationalId(s.nationalId),
    dateOfBirth: s.dateOfBirth ?? null,
    bankAccountHolder: s.bankAccountHolder ?? null,
    bankIbanMasked: maskIban(s.bankIban),
    bankBic: s.bankBic ?? null,
    bankRoutingNumber: s.bankRoutingNumber ?? null,
    bankAccountNumberMasked: maskAccountNumber(s.bankAccountNumber),
    bankAccountType: s.bankAccountType ?? null,
    homeAddress: s.homeAddress ?? null,
    idDocumentType: s.idDocumentType ?? null,
    idDocumentExpiresOn: s.idDocumentExpiresOn ?? null,
    idVerifiedAt: s.idVerifiedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// List and detail
// ---------------------------------------------------------------------------

async function employerIssueMap(db: Database, employers: EmployerRow[], keyring: EncryptionKeyring, today: string) {
  const out = new Map<string, HrPayrollIssue[]>();
  if (employers.length === 0) return out;
  const p = schema.hrPayrollProfiles;
  const profiles = await db
    .select()
    .from(p)
    .where(and(inArray(p.employerId, employers.map((r) => r.id)), eq(p.status, 'active')));
  for (const employer of employers) {
    const bank = await readEmployerBank(employer, keyring);
    const states = workStatesOf(profiles.filter((x) => x.employerId === employer.id));
    out.set(employer.id, employerIssues(employer, bank, states, Number(today.slice(0, 4))));
  }
  return out;
}

export async function listPayrollEmployees(
  db: Database,
  filters: { employerId?: string; onPayroll?: boolean },
  keyring: EncryptionKeyring,
  today: string = todayIso(),
): Promise<HrPayrollEmployeeListItem[]> {
  const e = schema.hrEmployees;
  const employees = await db.select({ id: e.id }).from(e).where(and(isNull(e.deletedAt), ne(e.status, 'terminated')));
  // Terminated employees stay in the list when they are still on a live payroll (final pay).
  const stillPaid = await db
    .select({ id: e.id })
    .from(e)
    .innerJoin(schema.hrPayrollProfiles, eq(schema.hrPayrollProfiles.employeeId, e.id))
    .where(and(isNull(e.deletedAt), eq(e.status, 'terminated'), ne(schema.hrPayrollProfiles.status, 'ended')));
  const ids = [...new Set([...employees, ...stillPaid].map((r) => r.id))];
  const data = await loadEmployeePayrollData(db, ids, keyring);

  const employers = [...new Map([...data.values()].filter((d) => d.employer).map((d) => [d.employer!.id, d.employer!])).values()];
  const employerIssuesById = await employerIssueMap(db, employers, keyring, today);
  const scheduleIds = [...new Set([...data.values()].map((d) => d.profile?.payScheduleId).filter((v): v is string => Boolean(v)))];
  const schedules = scheduleIds.length
    ? await db.select({ id: schema.hrPaySchedules.id, name: schema.hrPaySchedules.name }).from(schema.hrPaySchedules).where(inArray(schema.hrPaySchedules.id, scheduleIds))
    : [];
  const scheduleName = new Map(schedules.map((s) => [s.id, s.name]));

  const items: HrPayrollEmployeeListItem[] = [];
  for (const d of data.values()) {
    const onPayroll = Boolean(d.profile && d.profile.status !== 'ended');
    if (filters.onPayroll === true && !onPayroll) continue;
    if (filters.onPayroll === false && onPayroll) continue;
    if (filters.employerId && d.profile?.employerId !== filters.employerId) continue;
    const refDate = d.profile?.startDate && d.profile.startDate > today ? d.profile.startDate : today;
    const comp = compensationOn(d.compensations, refDate) ?? compensationOn(d.compensations, today);
    items.push({
      employeeId: d.employee.id,
      displayName: displayNameOf(d.employee),
      jobTitle: d.employee.jobTitle,
      avatarUrl: d.employee.avatarUrl,
      employeeStatus: d.employee.status,
      profile: d.profile ? { employerId: d.profile.employerId, payScheduleId: d.profile.payScheduleId, status: d.profile.status as ProfileDto['status'] } : null,
      employerName: d.employer?.name ?? null,
      payScheduleName: d.profile?.payScheduleId ? scheduleName.get(d.profile.payScheduleId) ?? null : null,
      country: (d.employer?.country as 'NL' | 'US' | undefined) ?? null,
      currentCompensation: comp ? toCompensationDto(comp) : null,
      issues: readinessIssues(d, { onDate: refDate, scope: 'list', employerIssues: d.employer ? employerIssuesById.get(d.employer.id) : [] }),
    });
  }
  return items.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getPayrollEmployee(
  db: Database,
  employeeId: string,
  keyring: EncryptionKeyring,
  today: string = todayIso(),
): Promise<HrPayrollEmployeeDetail> {
  const d = await loadOneEmployeePayrollData(db, employeeId, keyring);
  const employerIssuesById = d.employer ? await employerIssueMap(db, [d.employer], keyring, today) : new Map<string, HrPayrollIssue[]>();
  return {
    employee: {
      id: d.employee.id,
      displayName: displayNameOf(d.employee),
      email: d.employee.email,
      status: d.employee.status,
      startDate: d.employee.startDate,
      endDate: d.employee.endDate,
      weeklyHours: d.employee.weeklyHours,
    },
    profile: d.profile ? toProfileDto(d.profile) : null,
    employer: d.employer ? { id: d.employer.id, name: d.employer.name, country: d.employer.country as 'NL' | 'US', currency: d.employer.currency } : null,
    compensations: d.compensations.map(toCompensationDto),
    components: d.components.map(toComponentDto),
    currentElections: electionsInForce(d.elections, today).map(toElectionDto),
    paymentDetails: maskPaymentDetails(d.sensitive),
    issues: readinessIssues(d, { onDate: today, scope: 'list', employerIssues: d.employer ? employerIssuesById.get(d.employer.id) : [] }),
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** The next free income relationship number at an employer (1, 2, 3…), counting the transition-payment ones. */
async function nextIncomeRelationshipNumber(db: Database, employerId: string, exceptEmployeeId: string): Promise<number> {
  const p = schema.hrPayrollProfiles;
  const rows = await db.select({ nl: p.nl, employeeId: p.employeeId }).from(p).where(eq(p.employerId, employerId));
  let max = 0;
  for (const row of rows) {
    if (row.employeeId === exceptEmployeeId) continue;
    max = Math.max(max, row.nl.incomeRelationshipNumber ?? 0, row.nl.transitionIncomeRelationshipNumber ?? 0);
  }
  return max + 1;
}

/**
 * The income relationship number for an employee's transitievergoeding (loon uit vroegere dienstbetrekking, a
 * relationship of its own in the loonaangifte). Allocated the first time it is needed, like the normal number
 * (the next free one at the employer), and kept on the profile so it stays the same afterwards.
 */
export async function transitionIncomeRelationshipNumber(db: Database, employeeId: string): Promise<number | null> {
  const p = schema.hrPayrollProfiles;
  const [profile] = await db.select().from(p).where(eq(p.employeeId, employeeId)).limit(1);
  if (!profile) return null;
  if (profile.nl.transitionIncomeRelationshipNumber) return profile.nl.transitionIncomeRelationshipNumber;
  const next = await nextIncomeRelationshipNumber(db, profile.employerId, employeeId);
  // Our own number counts too: the next free one must differ from this employee's normal number.
  const number = Math.max(next, (profile.nl.incomeRelationshipNumber ?? 0) + 1);
  await db
    .update(p)
    .set({ nl: { ...profile.nl, transitionIncomeRelationshipNumber: number }, updatedAt: new Date() })
    .where(eq(p.id, profile.id));
  return number;
}

export async function upsertProfile(db: Database, employeeId: string, input: UpsertHrPayrollProfileInput): Promise<ProfileDto> {
  const employee = await requireEmployee(db, employeeId);
  const [employer] = await db
    .select()
    .from(schema.hrPayrollEmployers)
    .where(and(eq(schema.hrPayrollEmployers.id, input.employerId), isNull(schema.hrPayrollEmployers.deletedAt)))
    .limit(1);
  if (!employer) throw new HrNotFoundError('Payroll employer', input.employerId);
  if (!employer.isActive) throw new HrValidationError('This employer is not active');

  if (input.payScheduleId) {
    const [schedule] = await db
      .select()
      .from(schema.hrPaySchedules)
      .where(and(eq(schema.hrPaySchedules.id, input.payScheduleId), isNull(schema.hrPaySchedules.deletedAt)))
      .limit(1);
    if (!schedule || schedule.employerId !== employer.id) throw new HrValidationError('The pay schedule does not belong to this employer');
    if (!schedule.isActive) throw new HrValidationError('This pay schedule is not active');
  }
  assertDateOrder(input.startDate, input.endDate, 'Payroll');

  const p = schema.hrPayrollProfiles;
  const [existing] = await db.select().from(p).where(eq(p.employeeId, employeeId)).limit(1);

  if (existing && existing.employerId !== employer.id) {
    const [finalSlips] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.hrPayslips)
      .where(and(eq(schema.hrPayslips.employeeId, employeeId), eq(schema.hrPayslips.status, 'final')));
    if (Number(finalSlips?.count ?? 0) > 0) {
      throw new HrConflictError('This employee has payslips under another employer. End that payroll and start a new one.');
    }
  }

  const nl = { ...(existing?.nl ?? {}), ...(input.nl ?? {}) };
  const us = { ...(existing?.us ?? {}), ...(input.us ?? {}) };
  if (employer.country === 'NL') {
    if (nl.incomeRelationshipNumber) {
      const clash = (await db.select({ nl: p.nl, employeeId: p.employeeId }).from(p).where(eq(p.employerId, employer.id))).find(
        (row) => row.employeeId !== employeeId && row.nl.incomeRelationshipNumber === nl.incomeRelationshipNumber,
      );
      if (clash) throw new HrConflictError(`Income relationship number ${nl.incomeRelationshipNumber} is already used at this employer`);
    } else if (!existing || existing.employerId !== employer.id || !existing.nl.incomeRelationshipNumber) {
      nl.incomeRelationshipNumber = await nextIncomeRelationshipNumber(db, employer.id, employeeId);
    }
    if (nl.contractHoursPerWeek === undefined || nl.contractHoursPerWeek === null) nl.contractHoursPerWeek = employee.weeklyHours ?? null;
  }

  const values = {
    employerId: employer.id,
    payScheduleId: input.payScheduleId !== undefined ? input.payScheduleId : (existing?.payScheduleId ?? null),
    status: input.status ?? existing?.status ?? 'active',
    startDate: input.startDate !== undefined ? input.startDate : (existing?.startDate ?? null),
    endDate: input.endDate !== undefined ? input.endDate : (existing?.endDate ?? null),
    nl,
    us,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(p).set(values).where(eq(p.id, existing.id));
    const [row] = await db.select().from(p).where(eq(p.id, existing.id)).limit(1);
    return toProfileDto(row!);
  }
  const [row] = await db.insert(p).values({ id: generateId('hrpp'), employeeId, ...values }).returning();
  return toProfileDto(row!);
}

// ---------------------------------------------------------------------------
// Compensation
// ---------------------------------------------------------------------------

/** End of the latest period this employee was paid in (final payslips), or null. */
export async function lastApprovedPeriodEnd(db: Database, employeeId: string): Promise<string | null> {
  const [row] = await db
    .select({ end: sql<string | null>`max(${schema.hrPayslips.periodEnd})` })
    .from(schema.hrPayslips)
    .where(and(eq(schema.hrPayslips.employeeId, employeeId), eq(schema.hrPayslips.status, 'final')));
  return row?.end ?? null;
}

export async function createCompensation(
  db: Database,
  employeeId: string,
  input: CreateHrCompensationInput & { allowRetroactive?: boolean },
  ctx: { createdBy: string },
): Promise<CompensationDto> {
  const employee = await requireEmployee(db, employeeId);
  const [profile] = await db.select().from(schema.hrPayrollProfiles).where(eq(schema.hrPayrollProfiles.employeeId, employeeId)).limit(1);
  const [employer] = profile
    ? await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, profile.employerId)).limit(1)
    : [];

  if (input.payType === 'hourly' && input.period !== 'hour') throw new HrValidationError('Hourly pay is an amount per hour');
  if (input.payType === 'salary' && input.period === 'hour') throw new HrValidationError('A salary is an amount per week, month or year');

  const c = schema.hrCompensations;
  const existing = await db.select().from(c).where(eq(c.employeeId, employeeId)).orderBy(desc(c.effectiveFrom));
  const latest = existing[0];
  if (latest && input.effectiveFrom <= latest.effectiveFrom) {
    throw new HrValidationError(`A compensation effective from ${latest.effectiveFrom} already exists; the new one must start after it`);
  }
  const lastEnd = await lastApprovedPeriodEnd(db, employeeId);
  if (lastEnd && input.effectiveFrom <= lastEnd && !input.allowRetroactive) {
    throw new HrPayrollError(
      'RETROACTIVE_COMPENSATION',
      `Pay was already approved up to ${lastEnd}. Start the new compensation after that date, or confirm it is retroactive and correct the affected pay runs.`,
      409,
    );
  }

  const now = new Date();
  const id = generateId('hrcmp');
  const currency = (input.currency ?? employer?.currency ?? 'EUR').toUpperCase();
  await atomically(db, (h) => [
    ...(latest && latest.effectiveTo === null
      ? [h.update(c).set({ effectiveTo: addDays(input.effectiveFrom, -1), updatedAt: now }).where(eq(c.id, latest.id))]
      : []),
    h.insert(c).values({
      id,
      employeeId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      payType: input.payType,
      amount: decimal4(input.amount),
      period: input.period,
      currency,
      hoursPerWeek: input.hoursPerWeek ?? employee.weeklyHours ?? null,
      reason: input.reason ?? null,
      createdBy: ctx.createdBy,
    }),
  ]);
  const [row] = await db.select().from(c).where(eq(c.id, id)).limit(1);
  return toCompensationDto(row!);
}

/** Only the newest (open-ended) compensation can be removed, and only when no payslip depends on it. */
export async function deleteCompensation(db: Database, id: string): Promise<{ employeeId: string }> {
  const c = schema.hrCompensations;
  const [row] = await db.select().from(c).where(eq(c.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Compensation', id);
  if (row.effectiveTo !== null) throw new HrConflictError('Only the newest compensation can be removed');
  const lastEnd = await lastApprovedPeriodEnd(db, row.employeeId);
  if (lastEnd && row.effectiveFrom <= lastEnd) {
    throw new HrConflictError('Pay approved under this compensation depends on it, so it cannot be removed');
  }
  const previous = (await db.select().from(c).where(eq(c.employeeId, row.employeeId)).orderBy(desc(c.effectiveFrom))).find(
    (r) => r.id !== id && r.effectiveTo === addDays(row.effectiveFrom, -1),
  );
  await atomically(db, (h) => [
    h.delete(c).where(eq(c.id, id)),
    ...(previous ? [h.update(c).set({ effectiveTo: null, updatedAt: new Date() }).where(eq(c.id, previous.id))] : []),
  ]);
  return { employeeId: row.employeeId };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

async function employerCountryOf(db: Database, employeeId: string): Promise<'NL' | 'US'> {
  const [profile] = await db.select().from(schema.hrPayrollProfiles).where(eq(schema.hrPayrollProfiles.employeeId, employeeId)).limit(1);
  if (!profile) throw new HrValidationError('Put the employee on payroll first');
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, profile.employerId)).limit(1);
  if (!employer) throw new HrValidationError('The employee\'s employer no longer exists');
  return employer.country as 'NL' | 'US';
}

function validateComponent(
  country: 'NL' | 'US',
  code: string,
  amount: number | null | undefined,
  params: Record<string, number | string | boolean | null> | undefined,
) {
  const def = componentDef(code);
  if (!def) throw new HrValidationError(`Unknown pay component '${code}'`);
  if (!def.countries.includes(country)) throw new HrValidationError(`'${code}' is not available for ${country} payroll`);
  if (!def.recurring) throw new HrValidationError(`'${code}' is entered on a pay run, not as a recurring component`);
  const known = new Map((def.params ?? []).map((p) => [p.key, p]));
  for (const [key, value] of Object.entries(params ?? {})) {
    const spec = known.get(key);
    if (!spec) throw new HrValidationError(`'${code}' has no parameter '${key}'`);
    if (value === null) continue;
    if (spec.type === 'boolean' ? typeof value !== 'boolean' : spec.type === 'date' ? typeof value !== 'string' || !isIsoDate(value) : typeof value !== 'number') {
      throw new HrValidationError(`Parameter '${key}' of '${code}' has the wrong type`);
    }
  }
  for (const spec of def.params ?? []) {
    if (spec.required && (params?.[spec.key] === undefined || params[spec.key] === null)) {
      throw new HrValidationError(`'${code}' needs the parameter '${spec.key}'`);
    }
  }
  if (def.entry !== 'params' && (amount === null || amount === undefined) && Object.values(params ?? {}).every((v) => v === null || v === undefined)) {
    throw new HrValidationError(`'${code}' needs an amount${def.params?.length ? ' or its parameters' : ''}`);
  }
}

export async function createComponent(
  db: Database,
  employeeId: string,
  input: CreateHrPayComponentInput,
  ctx: { createdBy: string },
): Promise<ComponentDto> {
  await requireEmployee(db, employeeId);
  const country = await employerCountryOf(db, employeeId);
  validateComponent(country, input.code, input.amount, input.params);
  assertDateOrder(input.effectiveFrom, input.effectiveTo, 'Component');
  const [row] = await db
    .insert(schema.hrPayComponents)
    .values({
      id: generateId('hrpc'),
      employeeId,
      code: input.code,
      label: input.label ?? null,
      amount: input.amount === null || input.amount === undefined ? null : decimal2(input.amount),
      params: input.params ?? {},
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      createdBy: ctx.createdBy,
    })
    .returning();
  return toComponentDto(row!);
}

export async function requireComponent(db: Database, id: string): Promise<ComponentRow> {
  const [row] = await db
    .select()
    .from(schema.hrPayComponents)
    .where(and(eq(schema.hrPayComponents.id, id), isNull(schema.hrPayComponents.deletedAt)))
    .limit(1);
  if (!row) throw new HrNotFoundError('Pay component', id);
  return row;
}

export async function updateComponent(db: Database, id: string, input: UpdateHrPayComponentInput): Promise<ComponentDto> {
  const row = await requireComponent(db, id);
  const country = await employerCountryOf(db, row.employeeId);
  const amount = input.amount !== undefined ? input.amount : row.amount === null ? null : Number(row.amount);
  validateComponent(country, row.code, amount, input.params ?? row.params);
  assertDateOrder(input.effectiveFrom ?? row.effectiveFrom, input.effectiveTo !== undefined ? input.effectiveTo : row.effectiveTo, 'Component');
  const [updated] = await db
    .update(schema.hrPayComponents)
    .set({
      ...(input.label !== undefined && { label: input.label }),
      ...(input.amount !== undefined && { amount: input.amount === null ? null : decimal2(input.amount) }),
      ...(input.params !== undefined && { params: input.params }),
      ...(input.effectiveFrom !== undefined && { effectiveFrom: input.effectiveFrom }),
      ...(input.effectiveTo !== undefined && { effectiveTo: input.effectiveTo }),
      updatedAt: new Date(),
    })
    .where(eq(schema.hrPayComponents.id, id))
    .returning();
  return toComponentDto(updated!);
}

export async function deleteComponent(db: Database, id: string): Promise<{ employeeId: string }> {
  const row = await requireComponent(db, id);
  const now = new Date();
  await db.update(schema.hrPayComponents).set({ deletedAt: now, updatedAt: now }).where(eq(schema.hrPayComponents.id, id));
  return { employeeId: row.employeeId };
}

// ---------------------------------------------------------------------------
// Tax elections
// ---------------------------------------------------------------------------

export async function listElections(db: Database, employeeId: string): Promise<ElectionDto[]> {
  await requireEmployee(db, employeeId);
  const rows = await db
    .select()
    .from(schema.hrTaxElections)
    .where(eq(schema.hrTaxElections.employeeId, employeeId))
    .orderBy(desc(schema.hrTaxElections.effectiveFrom), desc(schema.hrTaxElections.createdAt));
  return rows.map(toElectionDto);
}

/**
 * Append a signed election. Rows are never edited: the one with the latest
 * `effective_from` (then the latest signature) is the one in force.
 */
export async function createElection(
  db: Database,
  employeeId: string,
  input: CreateHrTaxElectionInput,
  ctx: { signedBy: string; source: 'employee' | 'admin'; now?: Date },
): Promise<ElectionDto> {
  await requireEmployee(db, employeeId);
  const country = await employerCountryOf(db, employeeId);
  if (input.kind === 'nl_loonheffingskorting' && country !== 'NL') throw new HrValidationError('The loonheffingskorting is a Dutch election');
  if (input.kind !== 'nl_loonheffingskorting' && country !== 'US') throw new HrValidationError('W-4 and state certificates are US elections');
  const state = input.kind === 'us_state_certificate' ? input.state : null;
  if (state) {
    const module = stateModule(state);
    if (module && !module.certificate) throw new HrValidationError(`${state} has no withholding certificate`);
  }
  if (!input.signatureName.trim()) throw new HrValidationError('The signature name is required');

  const now = ctx.now ?? new Date();
  const [row] = await db
    .insert(schema.hrTaxElections)
    .values({
      id: generateId('hrte'),
      employeeId,
      kind: input.kind,
      state,
      effectiveFrom: input.effectiveFrom,
      data: input.data as never,
      signedBy: ctx.signedBy,
      signatureName: input.signatureName.trim(),
      signedAt: now,
      source: ctx.source,
      createdAt: now,
    })
    .returning();
  return toElectionDto(row!);
}

// ---------------------------------------------------------------------------
// Payment details (identity and bank, in the encrypted block)
// ---------------------------------------------------------------------------

const BANK_FIELDS = ['bankAccountHolder', 'bankIban', 'bankBic', 'bankRoutingNumber', 'bankAccountNumber', 'bankAccountType'] as const;

/**
 * Validate and write payment details. `null` clears a field, `undefined`
 * keeps it. From self-service `idVerifiedAt` is ignored: only HR verifies an
 * ID document. Returns the masked block and which fields changed.
 */
export async function setPaymentDetails(
  db: Database,
  employeeId: string,
  input: HrPayrollPaymentDetailsInput,
  ctx: { keyring: EncryptionKeyring; selfService: boolean; today?: string },
): Promise<{ details: HrPayrollPaymentDetailsMasked; changedFields: string[]; bankChanged: boolean }> {
  await requireEmployee(db, employeeId);
  const [profile] = await db.select().from(schema.hrPayrollProfiles).where(eq(schema.hrPayrollProfiles.employeeId, employeeId)).limit(1);
  let country: 'NL' | 'US' | null = null;
  if (profile) {
    const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, profile.employerId)).limit(1);
    country = (employer?.country as 'NL' | 'US' | undefined) ?? null;
  }
  const today = ctx.today ?? todayIso();
  const patch: HrEmployeeSensitive = {};

  if (input.nationalId !== undefined) {
    if (input.nationalId === null || input.nationalId.trim() === '') {
      patch.nationalId = null;
    } else {
      const bsn = normalizeBsn(input.nationalId);
      const ssn = normalizeSsn(input.nationalId);
      const valid = country === 'NL' ? bsn : country === 'US' ? ssn : (bsn ?? ssn);
      if (!valid) {
        throw new HrValidationError(country === 'NL' ? 'The BSN is not valid' : country === 'US' ? 'The SSN is not valid' : 'The BSN or SSN is not valid');
      }
      patch.nationalId = valid;
    }
  }
  if (input.dateOfBirth !== undefined) {
    if (input.dateOfBirth !== null) {
      if (!isIsoDate(input.dateOfBirth) || input.dateOfBirth > today) throw new HrValidationError('The date of birth is not valid');
      const age = ageOnDate(input.dateOfBirth, today);
      if (age < 12 || age > 110) throw new HrValidationError('The date of birth is not plausible');
    }
    patch.dateOfBirth = input.dateOfBirth;
  }
  if (input.bankIban !== undefined) {
    if (input.bankIban === null || input.bankIban.trim() === '') {
      patch.bankIban = null;
    } else {
      const iban = normalizeIban(input.bankIban);
      if (!isValidIban(iban)) throw new HrValidationError('The IBAN is not valid');
      patch.bankIban = iban;
    }
  }
  if (input.bankBic !== undefined) {
    if (input.bankBic === null || input.bankBic.trim() === '') {
      patch.bankBic = null;
    } else {
      const bic = normalizeBic(input.bankBic);
      if (!bic) throw new HrValidationError('The BIC is not valid');
      patch.bankBic = bic;
    }
  }
  if (input.bankRoutingNumber !== undefined) {
    if (input.bankRoutingNumber !== null && !isValidRoutingNumber(input.bankRoutingNumber)) {
      throw new HrValidationError('The routing number is not valid (checksum)');
    }
    patch.bankRoutingNumber = input.bankRoutingNumber;
  }
  if (input.bankAccountNumber !== undefined) patch.bankAccountNumber = input.bankAccountNumber;
  if (input.bankAccountType !== undefined) patch.bankAccountType = input.bankAccountType;
  if (input.bankAccountHolder !== undefined) patch.bankAccountHolder = input.bankAccountHolder?.trim() || null;
  if (input.homeAddress !== undefined) patch.homeAddress = input.homeAddress;
  if (input.idDocumentType !== undefined) patch.idDocumentType = input.idDocumentType;
  if (input.idDocumentNumber !== undefined) patch.idDocumentNumber = input.idDocumentNumber;
  if (input.idDocumentExpiresOn !== undefined) patch.idDocumentExpiresOn = input.idDocumentExpiresOn;
  if (!ctx.selfService && input.idVerifiedAt !== undefined) patch.idVerifiedAt = input.idVerifiedAt;

  const { changedFields } = await writeSensitive(db, employeeId, patch, ctx.keyring);
  const details = maskPaymentDetails((await loadOneEmployeePayrollData(db, employeeId, ctx.keyring)).sensitive);
  return {
    details,
    changedFields,
    bankChanged: changedFields.some((f) => (BANK_FIELDS as readonly string[]).includes(f)),
  };
}

// ---------------------------------------------------------------------------
// What the employee still has to provide (My HR and the portal)
// ---------------------------------------------------------------------------

export type MyPayrollDetails = HrMyPayrollDetails;

/** The state's certificate definition for clients that do not import the domain package. */
export function stateCertificateDefinition(state: string): HrStateCertificateDefinition | null {
  const certificate = stateModule(state)?.certificate;
  if (!certificate) return null;
  return {
    formName: certificate.formName,
    ...(certificate.filingStatuses ? { filingStatuses: certificate.filingStatuses } : {}),
    usesAllowances: certificate.usesAllowances,
    fields: certificate.fields.map((f) => ({
      key: f.key,
      type: f.type,
      ...(f.options ? { options: f.options } : {}),
      ...(f.required !== undefined ? { required: f.required } : {}),
      labelKey: f.labelKey,
    })),
  };
}

/**
 * What the signed-in employee sees under My HR / the portal: the masked
 * details, the elections in force, and what is still to be provided or signed.
 */
export async function myPayrollDetails(
  db: Database,
  employeeId: string,
  keyring: EncryptionKeyring,
  today: string = todayIso(),
): Promise<MyPayrollDetails> {
  const d = await loadOneEmployeePayrollData(db, employeeId, keyring);
  const onPayroll = Boolean(d.profile && d.profile.status !== 'ended' && d.employer);
  const country = onPayroll ? (d.employer!.country as 'NL' | 'US') : null;
  const inForce = electionsInForce(d.elections, today);

  const requiredElections: MyPayrollDetails['requiredElections'] = [];
  const missing: string[] = [];
  const s = d.sensitive;
  if (country === 'NL') {
    if (!electionOf(d.elections, today, 'nl_loonheffingskorting')) requiredElections.push({ kind: 'nl_loonheffingskorting', state: null });
    if (!s.nationalId) missing.push('nationalId');
    if (!s.dateOfBirth) missing.push('dateOfBirth');
    if (!s.bankIban) missing.push('bankIban');
    if (!s.idVerifiedAt && !s.idDocumentType && !s.idDocumentNumber) missing.push('idDocument');
  } else if (country === 'US') {
    if (!electionOf(d.elections, today, 'us_w4')) requiredElections.push({ kind: 'us_w4', state: null });
    const workState = d.profile?.us.workState?.toUpperCase() ?? null;
    if (workState && stateCertificateRequired(workState) && !electionOf(d.elections, today, 'us_state_certificate', workState)) {
      requiredElections.push({ kind: 'us_state_certificate', state: workState, certificate: stateCertificateDefinition(workState) });
    }
    if (!s.nationalId) missing.push('nationalId');
    if (!s.bankRoutingNumber) missing.push('bankRoutingNumber');
    if (!s.bankAccountNumber) missing.push('bankAccountNumber');
    if (!s.bankAccountType) missing.push('bankAccountType');
    if (!s.homeAddress?.line1 || !s.homeAddress.postalCode) missing.push('homeAddress');
  }

  return {
    country,
    employerName: onPayroll ? d.employer!.name : null,
    paymentDetails: maskPaymentDetails(s),
    elections: inForce.map(toElectionDto),
    requiredElections,
    missing,
  };
}
