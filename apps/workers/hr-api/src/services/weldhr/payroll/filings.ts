/**
 * Payroll filings: the Dutch loonaangifte per month, the US 941 per quarter,
 * 940 and W-2/W-3 per year, and the state withholding and unemployment
 * reports per quarter. They are built from FINAL payslips only.
 *
 * Approving a run creates or refreshes the filings it touches
 * (`ensureFilingsForRun`): a new filing starts `open`; one already `ready`,
 * submitted or filed goes back to `open` because new payslips changed it.
 * `generateFiling` rebuilds it from the payslips and stores the files in R2.
 *
 * Correction payslips hold differences (corrections.ts). A Dutch correction
 * whose corrected month is earlier than the month it is paid in goes into the
 * current return as a full replacement of that earlier month (originals plus
 * every correction approved so far); one in the same month is simply part of it.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, type SQL } from 'drizzle-orm';
import type { HrPayrollFilingEvent, HrPayrollFilingKind, HrPayrollIssue } from '@weldsuite/db/schema';
import { fromCents } from '@weldsuite/payroll-domain/money';
import type { NlFilingData, UsFilingData } from '@weldsuite/payroll-domain/types';
import type { LoonaangifteIkv, LoonaangifteInput } from '@weldsuite/payroll-domain/nl/loonaangifte';
import type { UsEmployeeForForms, UsEmployerForForms, UsFormResult, UsPayslipForForms } from '@weldsuite/payroll-domain/us/forms';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MarkHrPayrollFilingFiledInput } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import type { HrPayrollFiling as FilingDto } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { displayNameOf } from '../employees';
import { HrConflictError, HrNotFoundError, HrPayrollError } from '../shared';
import { endOfNextMonth, fileSafe, monthBounds, quarterBounds, ts, type EmployerRow, type FilingRow, type PayslipRow } from './common';
import type { PayrollDeps } from './deps';
import { decryptSensitive, transitionIncomeRelationshipNumber } from './employees';
import { addressLines, engineCall, safeId } from './format';
import { incomplete, invalidWith, structuredIssues } from './issues';

const f = schema.hrPayrollFilings;
const s = schema.hrPayslips;

export type { HrPayrollFilingKind };

export function quarterOfDate(iso: string): number {
  return Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export function toFilingDto(row: FilingRow, ctx: { employerName: string; currency?: string; digipoortAvailable: boolean }): FilingDto {
  return {
    id: row.id,
    employerId: row.employerId,
    employerName: ctx.employerName,
    country: row.country as 'NL' | 'US',
    kind: row.kind as FilingDto['kind'],
    state: row.state,
    taxYear: row.taxYear,
    period: row.period,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    dueDate: row.dueDate,
    status: row.status as FilingDto['status'],
    version: row.version,
    summary: row.summary,
    amountDue: row.amountDue,
    currency: ctx.currency ?? (row.country === 'NL' ? 'EUR' : 'USD'),
    issues: row.issues,
    paymentReference: row.paymentReference,
    fileName: row.fileName,
    generatedAt: ts(row.generatedAt),
    channel: (row.channel as FilingDto['channel']) ?? null,
    externalReference: row.externalReference,
    submittedAt: ts(row.submittedAt),
    history: row.history,
    canSubmit: row.kind === 'nl_loonaangifte' && (row.status === 'ready' || row.status === 'rejected') && Boolean(row.fileKey) && ctx.digipoortAvailable,
  };
}

async function employerInfo(db: Database, ids: string[]): Promise<Map<string, { name: string; currency: string }>> {
  const out = new Map<string, { name: string; currency: string }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: schema.hrPayrollEmployers.id, name: schema.hrPayrollEmployers.name, currency: schema.hrPayrollEmployers.currency })
    .from(schema.hrPayrollEmployers)
    .where(inArray(schema.hrPayrollEmployers.id, ids));
  for (const row of rows) out.set(row.id, { name: row.name, currency: row.currency });
  return out;
}

export async function toFilingDtos(db: Database, rows: FilingRow[], digipoortAvailable: boolean): Promise<FilingDto[]> {
  const employers = await employerInfo(db, [...new Set(rows.map((r) => r.employerId))]);
  return rows.map((row) => {
    const employer = employers.get(row.employerId);
    return toFilingDto(row, { employerName: employer?.name ?? '', currency: employer?.currency, digipoortAvailable });
  });
}

export async function requireFilingRow(db: Database, id: string): Promise<FilingRow> {
  const [row] = await db.select().from(f).where(eq(f.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('Payroll filing', id);
  return row;
}

export async function getFiling(db: Database, id: string, digipoortAvailable: boolean): Promise<FilingDto> {
  return (await toFilingDtos(db, [await requireFilingRow(db, id)], digipoortAvailable))[0]!;
}

export async function listFilings(
  db: Database,
  filters: { employerId?: string; year?: number; status?: string; kind?: string },
  digipoortAvailable: boolean,
): Promise<FilingDto[]> {
  const conditions: SQL[] = [];
  if (filters.employerId) conditions.push(eq(f.employerId, filters.employerId));
  if (filters.year) conditions.push(eq(f.taxYear, Number(filters.year)));
  if (filters.status) conditions.push(inArray(f.status, filters.status.split(',')));
  if (filters.kind) conditions.push(inArray(f.kind, filters.kind.split(',')));
  const rows = await db
    .select()
    .from(f)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(f.periodStart), asc(f.kind))
    .limit(500);
  return toFilingDtos(db, rows, digipoortAvailable);
}

/** Filings that are open or ready and due within 45 days (or overdue), oldest due first. */
export async function filingsDueSoon(db: Database, today: string, digipoortAvailable: boolean): Promise<FilingDto[]> {
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 45);
  const rows = await db
    .select()
    .from(f)
    .where(and(inArray(f.status, ['open', 'ready']), lte(f.dueDate, limit.toISOString().slice(0, 10))))
    .orderBy(asc(f.dueDate))
    .limit(50);
  return toFilingDtos(db, rows, digipoortAvailable);
}

// ---------------------------------------------------------------------------
// Which filings a payslip belongs to
// ---------------------------------------------------------------------------

interface FilingKey {
  kind: HrPayrollFilingKind;
  state: string | null;
  taxYear: number;
  /** Month (NL), quarter (941 and state quarterlies) or 0 (annual). */
  period: number;
}

/** The filings one final payslip feeds. */
export function filingKeysFor(country: string, slip: Pick<PayslipRow, 'payDate' | 'taxYear' | 'filingData'>): FilingKey[] {
  const payYear = Number(slip.payDate.slice(0, 4));
  if (country === 'NL') {
    return [{ kind: 'nl_loonaangifte', state: null, taxYear: payYear, period: Number(slip.payDate.slice(5, 7)) }];
  }
  const quarter = quarterOfDate(slip.payDate);
  const keys: FilingKey[] = [
    { kind: 'us_941', state: null, taxYear: payYear, period: quarter },
    { kind: 'us_940', state: null, taxYear: slip.taxYear, period: 0 },
    { kind: 'us_w2', state: null, taxYear: slip.taxYear, period: 0 },
  ];
  const data = slip.filingData as Partial<UsFilingData>;
  for (const state of Object.keys(data.states ?? {})) {
    keys.push({ kind: 'us_state_withholding', state, taxYear: payYear, period: quarter });
    keys.push({ kind: 'us_state_unemployment', state, taxYear: payYear, period: quarter });
  }
  return keys;
}

function boundsOf(key: FilingKey): { start: string; end: string } {
  if (key.kind === 'nl_loonaangifte') return monthBounds(key.taxYear, key.period);
  if (key.period === 0) return { start: `${key.taxYear}-01-01`, end: `${key.taxYear}-12-31` };
  return quarterBounds(key.taxYear, key.period);
}

function fallbackDueDate(key: FilingKey, deps: PayrollDeps): string {
  const bounds = boundsOf(key);
  if (key.kind === 'nl_loonaangifte') {
    try {
      return deps.engines.loonaangifteDueDate(key.taxYear, key.period);
    } catch {
      return endOfNextMonth(bounds.start);
    }
  }
  if (key.kind === 'us_940' || key.kind === 'us_w2') return `${key.taxYear + 1}-01-31`;
  return endOfNextMonth(bounds.end);
}

export interface TouchedFiling {
  id: string;
  created: boolean;
}

/** Create the filings an approved run feeds, and send those that already existed back to `open`. */
export async function ensureFilingsForRun(
  db: Database,
  employer: Pick<EmployerRow, 'id' | 'country'>,
  payslips: Array<Pick<PayslipRow, 'payDate' | 'taxYear' | 'filingData'>>,
  deps: PayrollDeps,
  ctx: { userId: string | null },
): Promise<TouchedFiling[]> {
  const keys = new Map<string, FilingKey>();
  for (const slip of payslips) {
    for (const key of filingKeysFor(employer.country, slip)) keys.set(`${key.kind}|${key.state ?? ''}|${key.taxYear}|${key.period}`, key);
  }
  const touched: TouchedFiling[] = [];
  const now = deps.now();
  for (const key of keys.values()) {
    const [existing] = await db
      .select()
      .from(f)
      .where(
        and(
          eq(f.employerId, employer.id),
          eq(f.kind, key.kind),
          eq(f.taxYear, key.taxYear),
          eq(f.period, key.period),
          key.state ? eq(f.state, key.state) : isNull(f.state),
        ),
      )
      .limit(1);
    if (!existing) {
      const bounds = boundsOf(key);
      const id = generateId('hrpf');
      await db.insert(f).values({
        id,
        employerId: employer.id,
        country: employer.country,
        kind: key.kind,
        state: key.state,
        taxYear: key.taxYear,
        period: key.period,
        periodStart: bounds.start,
        periodEnd: bounds.end,
        dueDate: fallbackDueDate(key, deps),
        status: 'open',
        history: [{ at: now.toISOString(), status: 'open', by: ctx.userId, message: 'Created by an approved pay run' }],
      });
      touched.push({ id, created: true });
    } else {
      if (existing.status !== 'open') {
        const history: HrPayrollFilingEvent[] = [
          ...existing.history,
          { at: now.toISOString(), status: 'open', by: ctx.userId, message: 'Reopened: new payslips were approved for this period' },
        ];
        await db.update(f).set({ status: 'open', history, updatedAt: now }).where(eq(f.id, existing.id));
      }
      touched.push({ id: existing.id, created: false });
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

function filingStorageKey(deps: PayrollDeps, filing: FilingRow, version: number, fileName: string): string {
  return `workspaces/${deps.workspaceKey}/hr/filings/${filing.employerId}/${filing.taxYear}/${filing.id}/v${version}/${fileSafe(fileName)}`;
}

function filingPrefix(deps: PayrollDeps, filing: FilingRow, version: number): string {
  return `workspaces/${deps.workspaceKey}/hr/filings/${filing.employerId}/${filing.taxYear}/${filing.id}/v${version}/`;
}

function requireBucket(deps: PayrollDeps): R2Bucket {
  if (!deps.bucket) throw new HrPayrollError('STORAGE_UNAVAILABLE', 'File storage is not available on this worker', 503);
  return deps.bucket;
}

interface BuiltFile {
  fileName: string;
  contentType: string;
  body: string | Uint8Array;
}

interface BuiltFiling {
  primary: BuiltFile;
  extras: BuiltFile[];
  summary: Record<string, number>;
  amountDueCents: number;
  dueDate?: string | null;
  paymentReference?: string | null;
  /** The builder's warnings (its errors never get this far). */
  issues: HrPayrollIssue[];
}

function initialsOf(firstName: string): string {
  return firstName
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}.`)
    .join('');
}

/** TotTeBet (cents) last reported for each corrected month, from the returns already generated for the year. */
async function previouslyReportedTotTeBet(db: Database, employerId: string, filing: FilingRow, months: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (months.length === 0) return out;
  const returns = await db
    .select()
    .from(f)
    .where(and(eq(f.employerId, employerId), eq(f.kind, 'nl_loonaangifte'), eq(f.taxYear, filing.taxYear)));
  for (const month of months) {
    const monthNumber = Number(month.slice(5, 7));
    const original = returns.find((r) => r.period === monthNumber);
    if (!original?.generatedAt || original.summary['TotTeBet'] === undefined) continue;
    let reported = original.summary['TotTeBet']!;
    for (const other of returns) {
      if (other.period >= filing.period || other.id === original.id) continue;
      const saldo = other.summary['Saldo:' + month + '-01'];
      if (saldo !== undefined) reported += saldo;
    }
    out.set(month, reported);
  }
  return out;
}

async function buildNl(db: Database, filing: FilingRow, employer: EmployerRow, deps: PayrollDeps): Promise<BuiltFiling> {
  const nl = employer.nlSettings;
  if (!nl.loonheffingennummer) throw incomplete('The employer has no loonheffingennummer', 'loonheffingennummer');
  const month = monthBounds(filing.taxYear, filing.period);

  const slips = await db
    .select()
    .from(s)
    .where(and(eq(s.employerId, employer.id), eq(s.status, 'final'), gte(s.payDate, month.start), lte(s.payDate, month.end)));
  const originalIds = [...new Set(slips.map((x) => x.correctsPayslipId).filter((v): v is string => Boolean(v)))];
  const originals = originalIds.length ? await db.select().from(s).where(inArray(s.id, originalIds)) : [];
  const originalById = new Map(originals.map((o) => [o.id, o]));

  const monthOf = (isoDate: string) => isoDate.slice(0, 7);
  const main: PayslipRow[] = [];
  const earlierCorrected = new Map<string, PayslipRow>(); // original id -> original, for corrections of earlier months
  for (const slip of slips) {
    const original = slip.correctsPayslipId ? originalById.get(slip.correctsPayslipId) : null;
    if (original && monthOf(original.payDate) !== monthOf(slip.payDate)) earlierCorrected.set(original.id, original);
    else main.push(slip);
  }

  const employeeIds = new Set<string>(main.map((x) => x.employeeId));
  const correctionMonths = new Map<string, Set<string>>(); // "YYYY-MM" of the corrected period -> original ids
  for (const original of earlierCorrected.values()) {
    const key = monthOf(original.payDate);
    const set = correctionMonths.get(key) ?? new Set<string>();
    set.add(original.id);
    correctionMonths.set(key, set);
  }

  // For each corrected month: every payslip paid in it, with the corrections approved up to the end of this month.
  const correctionSets: Array<{ month: string; slips: PayslipRow[] }> = [];
  for (const monthKey of correctionMonths.keys()) {
    const start = `${monthKey}-01`;
    const end = monthBounds(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7))).end;
    const paid = await db
      .select()
      .from(s)
      .where(and(eq(s.employerId, employer.id), eq(s.status, 'final'), gte(s.payDate, start), lte(s.payDate, end), isNull(s.correctsPayslipId)));
    const deltas = paid.length
      ? await db
          .select()
          .from(s)
          .where(and(inArray(s.correctsPayslipId, paid.map((p) => p.id)), eq(s.status, 'final'), lte(s.payDate, month.end)))
      : [];
    correctionSets.push({ month: monthKey, slips: [...paid, ...deltas] });
    for (const x of [...paid, ...deltas]) employeeIds.add(x.employeeId);
  }

  const people = employeeIds.size
    ? await db.select().from(schema.hrEmployees).where(inArray(schema.hrEmployees.id, [...employeeIds]))
    : [];
  const profiles = employeeIds.size
    ? await db.select().from(schema.hrPayrollProfiles).where(inArray(schema.hrPayrollProfiles.employeeId, [...employeeIds]))
    : [];
  const personById = new Map(people.map((p) => [p.id, p]));
  const profileById = new Map(profiles.map((p) => [p.employeeId, p]));
  const sensitiveById = new Map<string, Awaited<ReturnType<typeof decryptSensitive>>>();
  for (const person of people) sensitiveById.set(person.id, await decryptSensitive(person, deps.keyring));

  // A transitievergoeding is reported in an income relationship of its own: allocate that number once per employee.
  const paysTransition = (row: PayslipRow) => row.lines.some((l) => l.code === 'nl.transition_payment' && l.amountCents !== 0);
  const transitionNumbers = new Map<string, number>();
  for (const row of [...main, ...correctionSets.flatMap((set) => set.slips)]) {
    if (!paysTransition(row) || transitionNumbers.has(row.employeeId)) continue;
    const number = await transitionIncomeRelationshipNumber(db, row.employeeId);
    if (number) transitionNumbers.set(row.employeeId, number);
  }

  const ikvsFor = (rows: PayslipRow[]): LoonaangifteIkv[] => {
    const byEmployee = new Map<string, PayslipRow[]>();
    for (const row of rows) {
      if ((row.filingData as { kind?: string }).kind !== 'nl') continue;
      const list = byEmployee.get(row.employeeId) ?? [];
      list.push(row);
      byEmployee.set(row.employeeId, list);
    }
    const ikvs: LoonaangifteIkv[] = [];
    for (const [employeeId, items] of byEmployee) {
      const person = personById.get(employeeId);
      const profile = profileById.get(employeeId);
      if (!person || !profile) continue;
      const sensitive = sensitiveById.get(employeeId) ?? {};
      const address = sensitive.homeAddress ?? null;
      ikvs.push({
        identity: {
          bsn: sensitive.nationalId ?? null,
          initials: profile.nl.initials ?? initialsOf(person.firstName),
          surnamePrefix: profile.nl.surnamePrefix ?? null,
          surname: person.lastName,
          dateOfBirth: sensitive.dateOfBirth ?? null,
          nationality: profile.nl.nationality ?? null,
          gender: profile.nl.gender ?? null,
          address: address
            ? {
                street: address.line1 ?? null,
                houseNumber: address.houseNumber ?? null,
                houseNumberAddition: address.houseNumberAddition ?? null,
                postalCode: address.postalCode ?? null,
                city: address.city ?? null,
                country: address.country ?? null,
              }
            : null,
          personnelNumber: person.employeeNumber,
        },
        incomeRelationshipNumber: profile.nl.incomeRelationshipNumber ?? 0,
        employmentStart: profile.startDate ?? person.startDate ?? items[0]!.periodStart,
        employmentEnd: profile.endDate ?? person.endDate ?? null,
        endReasonCode: profile.nl.endReasonCode ?? null,
        caoCode: profile.nl.caoCode ?? null,
        transitionPaymentIncomeRelationshipNumber: items.some(paysTransition) ? transitionNumbers.get(employeeId) ?? null : null,
        filing: deps.engines.sumNlFilingData(items.map((x) => x.filingData as unknown as NlFilingData)),
      });
    }
    return ikvs.sort((a, b) => a.incomeRelationshipNumber - b.incomeRelationshipNumber);
  };

  // The base of each correction's saldo: what was last reported for that month (its own return, plus the saldi
  // of earlier returns that already corrected it).
  const previouslyReported = await previouslyReportedTotTeBet(db, employer.id, filing, correctionSets.map((set) => set.month));

  const input: LoonaangifteInput = {
    employer: { loonheffingennummer: nl.loonheffingennummer, name: employer.legalName, contactName: nl.contactName ?? null, contactPhone: nl.contactPhone ?? null, sectorCode: nl.sectorCode ?? null },
    software: { name: 'WeldSuite', version: '1.0', relationNumber: deps.nlSoftwareRelationNumber ?? null },
    taxYear: filing.taxYear,
    period: { start: month.start, end: month.end },
    ikvs: ikvsFor(main),
    corrections: correctionSets.map((set) => {
      const bounds = monthBounds(Number(set.month.slice(0, 4)), Number(set.month.slice(5, 7)));
      return { period: { start: bounds.start, end: bounds.end }, ikvs: ikvsFor(set.slips), previouslyReportedTotTeBetCents: previouslyReported.get(set.month) ?? null };
    }),
    createdAt: deps.now().toISOString(),
    messageId: `WS-${safeId(filing.id)}-v${filing.version}`.slice(0, 35),
  };
  if (input.ikvs.some((ikv) => !ikv.incomeRelationshipNumber)) {
    throw incomplete('An employee on this return has no income relationship number', 'income_relationship_number');
  }

  const result = engineCall('The loonaangifte builder', () => deps.engines.buildLoonaangifte(input));
  // The builder names an income relationship by its number; hand the issues on with the employee attached.
  const employeeOfRelationship = new Map<string, string>();
  for (const profile of profiles) if (profile.nl.incomeRelationshipNumber) employeeOfRelationship.set(String(profile.nl.incomeRelationshipNumber), profile.employeeId);
  const issues = structuredIssues(result.issues, (key, value) => (key === 'incomeRelationship' ? employeeOfRelationship.get(String(value)) : undefined));
  if (issues.some((i) => i.severity === 'error')) {
    throw invalidWith('FILING_INVALID', 'The loonaangifte has errors and was not stored', issues);
  }

  const extras: BuiltFile[] = [];
  try {
    const lang = nl.payslipLanguage ?? 'nl';
    const doc = deps.engines.loonaangifteSummaryDocument(result, input, lang);
    extras.push({ fileName: `loonaangifte-${filing.taxYear}-${String(filing.period).padStart(2, '0')}-summary.pdf`, contentType: 'application/pdf', body: await deps.pdf.document(doc) });
  } catch {
    // The printable summary is a convenience; the XML is the filing.
  }
  let dueDate: string | null = null;
  try {
    dueDate = deps.engines.loonaangifteDueDate(filing.taxYear, filing.period);
  } catch {
    dueDate = null;
  }
  return {
    primary: { fileName: result.file.fileName, contentType: result.file.contentType, body: result.file.content },
    extras,
    summary: result.summary,
    amountDueCents: result.amountDueCents,
    dueDate,
    paymentReference: deps.engines.paymentReference?.({ loonheffingennummer: nl.loonheffingennummer, taxYear: filing.taxYear, month: filing.period }) ?? null,
    issues: issues.filter((i) => i.severity !== 'error'),
  };
}

async function usEmployerForForms(employer: EmployerRow): Promise<UsEmployerForForms> {
  const us = employer.usSettings;
  return {
    name: employer.legalName,
    ein: us.ein ?? null,
    address: addressLines(employer.address, 'US'),
    depositSchedule: us.depositSchedule ?? 'monthly',
    states: Object.fromEntries(
      Object.entries(us.states ?? {}).map(([state, cfg]) => [state, { withholdingAccountNumber: cfg.withholdingAccountNumber ?? null, suiAccountNumber: cfg.suiAccountNumber ?? null }]),
    ),
  };
}

function formPayslip(row: PayslipRow): UsPayslipForForms {
  return {
    payslipId: row.id,
    employeeId: row.employeeId,
    payDate: row.payDate,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    filingData: row.filingData as unknown as UsFilingData,
  };
}

async function usEmployeesForForms(
  db: Database,
  rows: PayslipRow[],
  deps: PayrollDeps,
  opts: { fullSsn: boolean },
): Promise<Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }>> {
  const byEmployee = new Map<string, PayslipRow[]>();
  for (const row of rows) {
    if ((row.filingData as { kind?: string }).kind !== 'us') continue;
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeId, list);
  }
  const ids = [...byEmployee.keys()];
  const people = ids.length ? await db.select().from(schema.hrEmployees).where(inArray(schema.hrEmployees.id, ids)) : [];
  const out: Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }> = [];
  for (const person of people.sort((a, b) => displayNameOf(a).localeCompare(displayNameOf(b)))) {
    const sensitive = await decryptSensitive(person, deps.keyring);
    const ssn = sensitive.nationalId ?? null;
    out.push({
      employee: {
        employeeId: person.id,
        name: displayNameOf(person),
        ssn: opts.fullSsn ? ssn : ssn ? `***-**-${ssn.slice(-4)}` : null,
        address: addressLines(sensitive.homeAddress ?? null, 'US'),
      },
      payslips: byEmployee.get(person.id)!.map(formPayslip),
    });
  }
  return out;
}

async function buildUs(db: Database, filing: FilingRow, employer: EmployerRow, deps: PayrollDeps): Promise<BuiltFiling> {
  const employerForms = await usEmployerForForms(employer);
  const quarter = filing.period as 1 | 2 | 3 | 4;
  const quarterly = quarterBounds(filing.taxYear, quarter || 1);
  const finals = and(eq(s.employerId, employer.id), eq(s.status, 'final'));
  const inQuarter = await db.select().from(s).where(and(finals, gte(s.payDate, quarterly.start), lte(s.payDate, quarterly.end)));
  const inYear = await db.select().from(s).where(and(finals, eq(s.taxYear, filing.taxYear)));

  let result: UsFormResult;
  switch (filing.kind) {
    case 'us_941':
      result = engineCall('Form 941', () => deps.engines.form941({ employer: employerForms, taxYear: filing.taxYear, quarter, payslips: inQuarter.filter((x) => (x.filingData as { kind?: string }).kind === 'us').map(formPayslip) }));
      break;
    case 'us_940':
      result = engineCall('Form 940', () => deps.engines.form940({ employer: employerForms, taxYear: filing.taxYear, payslips: inYear.filter((x) => (x.filingData as { kind?: string }).kind === 'us').map(formPayslip) }));
      break;
    case 'us_w2': {
      const employees = await usEmployeesForForms(db, inYear, deps, { fullSsn: true });
      result = engineCall('Form W-3', () => deps.engines.formW3({ employer: employerForms, taxYear: filing.taxYear, employees }));
      break;
    }
    case 'us_state_withholding':
    case 'us_state_unemployment': {
      const state = filing.state!;
      const withState = inQuarter.filter((x) => Boolean((x.filingData as Partial<UsFilingData>).states?.[state]));
      const employees = await usEmployeesForForms(db, withState, deps, { fullSsn: true });
      const args = { employer: employerForms, state, taxYear: filing.taxYear, quarter, employees };
      result =
        filing.kind === 'us_state_withholding'
          ? engineCall(`The ${state} withholding report`, () => deps.engines.stateWithholdingReport(args))
          : engineCall(`The ${state} unemployment report`, () => deps.engines.stateUnemploymentReport(args));
      break;
    }
    default:
      throw new HrConflictError('This is not a US filing');
  }

  const label = filing.kind.replace('us_', '').replace('state_', 'state-') + (filing.state ? `-${filing.state}` : '');
  const pdf: BuiltFile = {
    fileName: `${label}-${filing.taxYear}${filing.period ? `-q${filing.period}` : ''}.pdf`,
    contentType: 'application/pdf',
    body: await deps.pdf.document(result.document),
  };
  const files: BuiltFile[] = (result.files ?? []).map((file) => ({ fileName: file.fileName, contentType: file.contentType, body: file.content }));
  // State reports are wage lists the employer uploads: the CSV is the file, the PDF a printable copy.
  const stateReport = filing.kind === 'us_state_withholding' || filing.kind === 'us_state_unemployment';
  const primary = stateReport && files.length ? files[0]! : pdf;
  const extras = primary === pdf ? files : [pdf, ...files.slice(1)];
  return { primary, extras, summary: result.summary, amountDueCents: result.amountDueCents, dueDate: result.dueDate, issues: [] };
}

/** Rebuild a filing from final payslips and store its files. */
export async function generateFiling(db: Database, id: string, deps: PayrollDeps, ctx: { userId: string }): Promise<FilingRow> {
  const filing = await requireFilingRow(db, id);
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, filing.employerId)).limit(1);
  if (!employer) throw new HrNotFoundError('Payroll employer', filing.employerId);
  const bucket = requireBucket(deps);

  const resubmission = ['submitted', 'accepted', 'filed', 'rejected'].includes(filing.status);
  const version = resubmission ? filing.version + 1 : filing.version;
  let built: BuiltFiling;
  try {
    built = filing.country === 'NL' ? await buildNl(db, { ...filing, version }, employer, deps) : await buildUs(db, filing, employer, deps);
  } catch (err) {
    // Keep the builder's errors on the filing so the screen can show what to fix; nothing else changes.
    const details = err instanceof HrPayrollError ? (err.details as { issues?: HrPayrollIssue[] } | undefined) : undefined;
    if (details?.issues) await db.update(f).set({ issues: details.issues, updatedAt: deps.now() }).where(eq(f.id, id));
    throw err;
  }

  const put = async (file: BuiltFile) => {
    const key = filingStorageKey(deps, filing, version, file.fileName);
    await bucket.put(key, file.body, { httpMetadata: { contentType: file.contentType } });
    return key;
  };
  const fileKey = await put(built.primary);
  for (const extra of built.extras) await put(extra);

  const now = deps.now();
  const history: HrPayrollFilingEvent[] = [
    ...filing.history,
    { at: now.toISOString(), status: 'ready', by: ctx.userId, message: resubmission ? `Regenerated (version ${version})` : 'Generated' },
  ];
  await db
    .update(f)
    .set({
      status: 'ready',
      version,
      summary: built.summary,
      amountDue: fromCents(built.amountDueCents),
      ...(built.dueDate ? { dueDate: built.dueDate } : {}),
      paymentReference: built.paymentReference ?? null,
      fileKey,
      fileName: built.primary.fileName,
      contentType: built.primary.contentType,
      generatedAt: now,
      ...(resubmission ? { channel: null, externalReference: null, submittedAt: null, submittedBy: null } : {}),
      history,
      issues: built.issues,
      updatedAt: now,
    })
    .where(eq(f.id, id));
  return requireFilingRow(db, id);
}

/** The stored file of a filing (`name` picks one of the extra files stored beside it). */
export async function filingFile(db: Database, id: string, deps: PayrollDeps, name?: string | null) {
  const filing = await requireFilingRow(db, id);
  if (!filing.fileKey || !deps.bucket) throw new HrNotFoundError('Filing file', id);
  const prefix = filingPrefix(deps, filing, filing.version);
  if (!filing.fileKey.startsWith(prefix)) throw new HrNotFoundError('Filing file', id);
  const key = name ? `${prefix}${fileSafe(name)}` : filing.fileKey;
  const object = await deps.bucket.get(key);
  if (!object) throw new HrNotFoundError('Filing file', id);
  const contentType = name ? (name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.csv') ? 'text/csv' : name.endsWith('.xml') ? 'application/xml' : 'application/octet-stream') : filing.contentType ?? 'application/octet-stream';
  return { object, fileName: name ? fileSafe(name) : filing.fileName ?? 'filing', contentType };
}

// ---------------------------------------------------------------------------
// Submitting and recording
// ---------------------------------------------------------------------------

export function digipoortAvailable(flagOn: boolean, deps: Pick<PayrollDeps, 'digipoort'>): boolean {
  return flagOn && deps.digipoort !== null;
}

function notConfigured(): HrPayrollError {
  return new HrPayrollError(
    'DIGIPOORT_NOT_CONFIGURED',
    'Sending over Digipoort is not set up (it needs the PKIoverheid certificate and the Digipoort connection). Download the file and file it yourself, then mark it as filed.',
    409,
  );
}

export async function submitFiling(db: Database, id: string, deps: PayrollDeps, ctx: { userId: string; flagOn: boolean }): Promise<FilingRow> {
  const filing = await requireFilingRow(db, id);
  if (filing.kind !== 'nl_loonaangifte') throw new HrConflictError('Only the Dutch loonaangifte can be sent from WeldSuite');
  if (!ctx.flagOn || !deps.digipoort) throw notConfigured();
  if (filing.status !== 'ready' && filing.status !== 'rejected') throw new HrConflictError(`This filing is ${filing.status} and cannot be submitted`);
  if (!filing.fileKey || !deps.bucket) throw new HrConflictError('Generate the filing first');
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, filing.employerId)).limit(1);
  const lhn = employer?.nlSettings.loonheffingennummer;
  if (!lhn) throw new HrPayrollError('EMPLOYER_INCOMPLETE', 'The employer has no loonheffingennummer', 409);
  const object = await deps.bucket.get(filing.fileKey);
  if (!object) throw new HrNotFoundError('Filing file', id);
  const xml = await object.text();

  let reference: string;
  try {
    ({ reference } = await deps.digipoort.submit({ xml, fileName: filing.fileName ?? 'loonaangifte.xml', loonheffingennummer: lhn, messageId: `WS-${safeId(filing.id)}-v${filing.version}`.slice(0, 35) }));
  } catch (err) {
    throw new HrPayrollError('DIGIPOORT_ERROR', `Digipoort did not accept the message: ${err instanceof Error ? err.message : 'unknown error'}`, 503);
  }
  const now = deps.now();
  const history: HrPayrollFilingEvent[] = [...filing.history, { at: now.toISOString(), status: 'submitted', by: ctx.userId, message: `Sent over Digipoort (${reference})` }];
  await db
    .update(f)
    .set({ status: 'submitted', channel: 'digipoort', externalReference: reference, submittedBy: ctx.userId, submittedAt: now, history, updatedAt: now })
    .where(eq(f.id, id));
  return requireFilingRow(db, id);
}

export async function refreshFilingStatus(db: Database, id: string, deps: PayrollDeps, ctx: { userId: string; flagOn: boolean }): Promise<FilingRow> {
  const filing = await requireFilingRow(db, id);
  if (filing.channel !== 'digipoort' || !filing.externalReference) throw new HrConflictError('This filing was not sent over Digipoort');
  if (!ctx.flagOn || !deps.digipoort) throw notConfigured();
  let status: { status: 'submitted' | 'accepted' | 'rejected'; message?: string | null };
  try {
    status = await deps.digipoort.status(filing.externalReference);
  } catch (err) {
    throw new HrPayrollError('DIGIPOORT_ERROR', `Digipoort status could not be read: ${err instanceof Error ? err.message : 'unknown error'}`, 503);
  }
  if (status.status === filing.status) return filing;
  const now = deps.now();
  const history: HrPayrollFilingEvent[] = [...filing.history, { at: now.toISOString(), status: status.status, by: ctx.userId, message: status.message ?? null }];
  await db.update(f).set({ status: status.status, history, updatedAt: now }).where(eq(f.id, id));
  return requireFilingRow(db, id);
}

export async function markFilingFiled(db: Database, id: string, input: MarkHrPayrollFilingFiledInput, ctx: { userId: string; now: Date }): Promise<FilingRow> {
  const filing = await requireFilingRow(db, id);
  if (!['ready', 'submitted', 'rejected'].includes(filing.status)) {
    throw new HrConflictError(filing.status === 'open' ? 'Generate the filing before marking it as filed' : `This filing is already ${filing.status}`);
  }
  const filedAt = input.filedOn ? new Date(`${input.filedOn}T12:00:00Z`) : ctx.now;
  const history: HrPayrollFilingEvent[] = [
    ...filing.history,
    { at: ctx.now.toISOString(), status: 'filed', by: ctx.userId, message: input.externalReference ? `Filed by the employer (${input.externalReference})` : 'Filed by the employer' },
  ];
  await db
    .update(f)
    .set({
      status: 'filed',
      channel: filing.channel ?? 'manual',
      externalReference: input.externalReference ?? filing.externalReference,
      submittedBy: ctx.userId,
      submittedAt: filedAt,
      history,
      updatedAt: ctx.now,
    })
    .where(eq(f.id, id));
  return requireFilingRow(db, id);
}

