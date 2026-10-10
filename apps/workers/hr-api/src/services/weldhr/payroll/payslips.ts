/**
 * Payslips: the DTOs, the printable view, the PDF (stored in R2 once final,
 * rendered on the fly with a watermark while draft) and the employee's own
 * list.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { payslipLineKey, type PayslipView, type PayslipYtdView } from '@weldsuite/payroll-domain/payslip-pdf';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { HrMyPayslip, HrPayslip as PayslipDto, HrPayslipSummary } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { displayNameOf } from '../employees';
import { HrNotFoundError } from '../shared';
import { sortIssues, ts, type EmployerRow, type PayslipRow } from './common';
import { addTotals, rowTotals, zeroTotals } from './corrections';
import type { PayrollDeps } from './deps';
import { decryptSensitive } from './employees';
import { addressLines } from './format';
import { maskIban, maskNationalId } from './validators';
import { approvedBefore } from './ytd';

const s = schema.hrPayslips;

export async function requirePayslip(db: Database, id: string, onlyEmployeeId?: string): Promise<PayslipRow> {
  const [row] = await db.select().from(s).where(eq(s.id, id)).limit(1);
  if (!row || (onlyEmployeeId && (row.employeeId !== onlyEmployeeId || row.status !== 'final'))) throw new HrNotFoundError('Payslip', id);
  return row;
}

export async function getPayslip(db: Database, id: string): Promise<PayslipDto> {
  const row = await requirePayslip(db, id);
  const [employee] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, row.employeeId)).limit(1);
  const [employer] = await db.select({ name: schema.hrPayrollEmployers.name }).from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, row.employerId)).limit(1);
  return {
    id: row.id,
    runId: row.runId,
    employeeId: row.employeeId,
    employeeName: employee ? displayNameOf(employee) : '',
    employerId: row.employerId,
    employerName: employer?.name ?? '',
    country: row.country as 'NL' | 'US',
    currency: row.currency,
    status: row.status as PayslipDto['status'],
    number: row.number,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    payDate: row.payDate,
    taxYear: row.taxYear,
    periodNumber: row.periodNumber,
    grossPay: row.grossPay,
    taxableWage: row.taxableWage,
    employeeTaxes: row.employeeTaxes,
    employeeDeductions: row.employeeDeductions,
    reimbursements: row.reimbursements,
    netPay: row.netPay,
    employerTaxes: row.employerTaxes,
    employerCost: row.employerCost,
    lines: row.lines,
    ytd: row.ytd,
    issues: sortIssues(row.issues),
    correctsPayslipId: row.correctsPayslipId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The payslips of one employee, newest first (back office). */
export async function listEmployeePayslips(db: Database, employeeId: string): Promise<HrPayslipSummary[]> {
  const rows = await db.select().from(s).where(and(eq(s.employeeId, employeeId), eq(s.status, 'final'))).orderBy(desc(s.payDate), desc(s.createdAt)).limit(200);
  const [employee] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, employeeId)).limit(1);
  if (!employee) throw new HrNotFoundError('Employee', employeeId);
  const name = displayNameOf(employee);
  return rows.map((row, index) => ({
    id: row.id,
    employeeId: row.employeeId,
    employeeName: name,
    status: row.status as HrPayslipSummary['status'],
    number: row.number,
    grossPay: row.grossPay,
    employeeTaxes: row.employeeTaxes,
    netPay: row.netPay,
    employerCost: row.employerCost,
    issues: sortIssues(row.issues),
    previousNetPay: rows[index + 1]?.netPay ?? null,
    runId: row.runId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    payDate: row.payDate,
    currency: row.currency,
    employeeDeductions: row.employeeDeductions,
    reimbursements: row.reimbursements,
  }));
}

/** The employee's own final payslips (My HR and the portal). */
export async function myPayslips(db: Database, employeeId: string): Promise<HrMyPayslip[]> {
  const rows = await db
    .select({ slip: s, employerName: schema.hrPayrollEmployers.name })
    .from(s)
    .innerJoin(schema.hrPayrollEmployers, eq(schema.hrPayrollEmployers.id, s.employerId))
    .where(and(eq(s.employeeId, employeeId), eq(s.status, 'final')))
    .orderBy(desc(s.payDate), desc(s.createdAt))
    .limit(240);
  return rows.map(({ slip, employerName }) => ({
    id: slip.id,
    number: slip.number,
    employerName,
    currency: slip.currency,
    periodStart: slip.periodStart,
    periodEnd: slip.periodEnd,
    payDate: slip.payDate,
    grossPay: slip.grossPay,
    netPay: slip.netPay,
    viewedAt: ts(slip.employeeViewedAt),
  }));
}

/** Stamp the first time the employee opened a payslip. */
export async function markPayslipViewed(db: Database, id: string, at: Date): Promise<void> {
  const row = await requirePayslip(db, id);
  if (!row.employeeViewedAt) await db.update(s).set({ employeeViewedAt: at }).where(eq(s.id, id));
}

// ---------------------------------------------------------------------------
// The printable view
// ---------------------------------------------------------------------------

/** Year to date after `row`: the year's final payslips approved before it, plus itself. */
async function ytdViewOf(db: Database, row: PayslipRow): Promise<PayslipYtdView> {
  const others = await db
    .select()
    .from(s)
    .where(and(eq(s.employeeId, row.employeeId), eq(s.employerId, row.employerId), eq(s.taxYear, row.taxYear), eq(s.status, 'final')));
  const earlier = row.number ? approvedBefore(others, row.number) : others.filter((o) => o.id !== row.id);
  const items = [...earlier.filter((o) => o.id !== row.id), row];
  let totals = zeroTotals();
  const byLine: Record<string, number> = {};
  for (const item of items) {
    totals = addTotals(totals, rowTotals(item));
    for (const line of item.lines) {
      const key = payslipLineKey(line);
      byLine[key] = (byLine[key] ?? 0) + line.amountCents;
    }
  }
  return { totals, byLine };
}

export function languageOf(employer: Pick<EmployerRow, 'country' | 'nlSettings'>): 'en' | 'nl' {
  if (employer.country === 'NL') return employer.nlSettings.payslipLanguage ?? 'nl';
  return 'en';
}

export async function buildPayslipView(db: Database, row: PayslipRow, deps: Pick<PayrollDeps, 'keyring'>): Promise<{ view: PayslipView; lang: 'en' | 'nl' }> {
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, row.employerId)).limit(1);
  const [employee] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, row.employeeId)).limit(1);
  if (!employer || !employee) throw new HrNotFoundError('Payslip', row.id);
  const [profile] = await db.select().from(schema.hrPayrollProfiles).where(eq(schema.hrPayrollProfiles.employeeId, row.employeeId)).limit(1);
  const sensitive = await decryptSensitive(employee, deps.keyring);
  const lang = languageOf(employer);
  const country = employer.country as 'NL' | 'US';

  let correction: PayslipView['correction'] = null;
  if (row.correctsPayslipId) {
    const [original] = await db.select({ number: s.number }).from(s).where(eq(s.id, row.correctsPayslipId)).limit(1);
    correction = { originalNumber: original?.number ?? null };
  }

  const view: PayslipView = {
    country,
    currency: row.currency,
    number: row.number,
    employer: {
      name: employer.name,
      legalName: employer.legalName,
      address: addressLines(employer.address, country),
      taxId:
        country === 'NL'
          ? employer.nlSettings.loonheffingennummer
            ? { label: 'Loonheffingennummer', value: employer.nlSettings.loonheffingennummer }
            : null
          : employer.usSettings.ein
            ? { label: 'EIN', value: employer.usSettings.ein }
            : null,
    },
    employee: {
      name: displayNameOf(employee),
      address: addressLines(sensitive.homeAddress ?? null, country),
      employeeNumber: employee.employeeNumber,
      jobTitle: employee.jobTitle,
      taxIdMasked: maskNationalId(sensitive.nationalId),
      dateOfBirth: country === 'NL' ? sensitive.dateOfBirth ?? null : null,
    },
    period: { start: row.periodStart, end: row.periodEnd, payDate: row.payDate, periodNumber: row.periodNumber, taxYear: row.taxYear },
    lines: row.lines,
    totals: rowTotals(row),
    ytd: await ytdViewOf(db, row),
    nl:
      country === 'NL'
        ? {
            contractHoursPerWeek: profile?.nl.contractHoursPerWeek ?? employee.weeklyHours ?? null,
            writtenContract: profile?.nl.writtenContract ?? false,
            indefiniteContract: profile?.nl.indefiniteContract ?? false,
            onCall: profile?.nl.onCall ?? false,
            // The NL engine puts the applicable statutory minimum hourly wage on the payslip as an info line.
            minimumHourlyWageCents: row.lines.find((l) => l.code === 'nl.minimum_wage')?.amountCents ?? null,
          }
        : null,
    us: country === 'US' ? { workState: profile?.us.workState ?? null } : null,
    payTo: country === 'NL' ? maskIban(sensitive.bankIban) : sensitive.bankAccountNumber ? `•••• ${sensitive.bankAccountNumber.slice(-4)}` : null,
    correction,
    watermark: row.status === 'final' ? null : lang === 'nl' ? 'CONCEPT' : 'DRAFT',
  };
  return { view, lang };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export function payslipFileKey(workspaceKey: string, row: Pick<PayslipRow, 'id' | 'taxYear'>): string {
  return `workspaces/${workspaceKey}/hr/payslips/${row.taxYear}/${row.id}.pdf`;
}

/** Render a payslip and, once final, keep the PDF in R2. Failures to store are logged, never fatal. */
export async function renderAndStorePayslip(db: Database, row: PayslipRow, deps: PayrollDeps): Promise<Uint8Array> {
  const { view, lang } = await buildPayslipView(db, row, deps);
  const bytes = await deps.pdf.payslip(view, lang);
  if (row.status === 'final' && deps.bucket) {
    const key = payslipFileKey(deps.workspaceKey, row);
    try {
      await deps.bucket.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
      await db.update(s).set({ fileKey: key }).where(eq(s.id, row.id));
    } catch (err) {
      console.error('[payroll] could not store the payslip PDF:', err instanceof Error ? err.message : err);
    }
  }
  return bytes;
}

/**
 * The payslip's PDF: the stored file for a final payslip (payslips are
 * immutable records with a retention duty), rendered again from the stored
 * lines when the object is missing; a draft is rendered with a watermark.
 */
export async function payslipPdf(db: Database, row: PayslipRow, deps: PayrollDeps): Promise<Uint8Array> {
  if (row.status === 'final' && row.fileKey && deps.bucket) {
    // The prefix check keeps a tampered key from reading another workspace's files.
    if (row.fileKey.startsWith(`workspaces/${deps.workspaceKey}/hr/payslips/`)) {
      const object = await deps.bucket.get(row.fileKey);
      if (object) return new Uint8Array(await object.arrayBuffer());
    }
  }
  return renderAndStorePayslip(db, row, deps);
}

/** Employees with an active portal access or a linked member, for the "payslip ready" email. */
export async function employeesToNotify(db: Database, employeeIds: string[]): Promise<Array<{ id: string; email: string; name: string }>> {
  if (employeeIds.length === 0) return [];
  const e = schema.hrEmployees;
  const rows = await db
    .select({ id: e.id, email: e.email, firstName: e.firstName, lastName: e.lastName, preferredName: e.preferredName, userId: e.userId })
    .from(e)
    .where(and(inArray(e.id, employeeIds), isNull(e.deletedAt)));
  const access = await db
    .select({ employeeId: schema.hrPortalAccess.employeeId })
    .from(schema.hrPortalAccess)
    .where(and(inArray(schema.hrPortalAccess.employeeId, employeeIds), eq(schema.hrPortalAccess.status, 'active')));
  const withPortal = new Set(access.map((a) => a.employeeId));
  return rows.filter((r) => r.userId || withPortal.has(r.id)).map((r) => ({ id: r.id, email: r.email, name: displayNameOf(r) }));
}
