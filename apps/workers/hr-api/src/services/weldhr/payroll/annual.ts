/**
 * Annual statements: the Dutch jaaropgaaf and the US W-2 (employee copy),
 * built from the year's final payslips by the country builders and rendered
 * to PDF on request (they are derived, not stored: the payslips are).
 */

import { and, asc, eq } from 'drizzle-orm';
import type { NlFilingData, UsFilingData } from '@weldsuite/payroll-domain/types';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { HrAnnualStatement } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { displayNameOf } from '../employees';
import { HrNotFoundError } from '../shared';
import type { PayslipRow } from './common';
import type { PayrollDeps } from './deps';
import { decryptSensitive } from './employees';
import { addressLines, annualStatementFileName, engineCall } from './format';
import { languageOf } from './payslips';
import { compareNumberOrder } from './ytd';
import { maskSsn } from './validators';

const s = schema.hrPayslips;

export async function listAnnualStatements(db: Database, employeeId: string): Promise<HrAnnualStatement[]> {
  const rows = await db
    .select({ year: s.taxYear, employerId: s.employerId, employerName: schema.hrPayrollEmployers.name, country: schema.hrPayrollEmployers.country })
    .from(s)
    .innerJoin(schema.hrPayrollEmployers, eq(schema.hrPayrollEmployers.id, s.employerId))
    .where(and(eq(s.employeeId, employeeId), eq(s.status, 'final')));
  const seen = new Map<string, HrAnnualStatement>();
  for (const row of rows) {
    const key = `${row.year}|${row.employerId}`;
    if (!seen.has(key)) {
      seen.set(key, { year: row.year, employerId: row.employerId, employerName: row.employerName, kind: row.country === 'NL' ? 'jaaropgaaf' : 'w2' });
    }
  }
  return [...seen.values()].sort((a, b) => b.year - a.year || a.employerName.localeCompare(b.employerName));
}

export async function annualStatementPdf(
  db: Database,
  employeeId: string,
  year: number,
  employerId: string,
  deps: PayrollDeps,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, employerId)).limit(1);
  const [employee] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, employeeId)).limit(1);
  if (!employer || !employee) throw new HrNotFoundError('Annual statement', `${employerId}/${year}`);
  const slips: PayslipRow[] = (
    await db
      .select()
      .from(s)
      .where(and(eq(s.employeeId, employeeId), eq(s.employerId, employerId), eq(s.taxYear, year), eq(s.status, 'final')))
      .orderBy(asc(s.payDate))
  ).sort(compareNumberOrder);
  if (slips.length === 0) throw new HrNotFoundError('Annual statement', `${employerId}/${year}`);

  const sensitive = await decryptSensitive(employee, deps.keyring);
  const [profile] = await db.select().from(schema.hrPayrollProfiles).where(eq(schema.hrPayrollProfiles.employeeId, employeeId)).limit(1);
  const lang = languageOf(employer);
  const country = employer.country as 'NL' | 'US';
  const fileName = annualStatementFileName(country, year);

  if (country === 'NL') {
    const doc = engineCall('The jaaropgaaf builder', () =>
      deps.engines.nlAnnualStatement({
        lang,
        year,
        employer: { name: employer.legalName, loonheffingennummer: employer.nlSettings.loonheffingennummer ?? null, address: addressLines(employer.address, 'NL') },
        employee: {
          name: displayNameOf(employee),
          bsn: sensitive.nationalId ?? null,
          dateOfBirth: sensitive.dateOfBirth ?? null,
          address: addressLines(sensitive.homeAddress ?? null, 'NL'),
          employmentStart: profile?.startDate ?? employee.startDate,
          employmentEnd: profile?.endDate ?? employee.endDate,
          personnelNumber: employee.employeeNumber,
        },
        payslips: slips
          .filter((x) => (x.filingData as { kind?: string }).kind === 'nl')
          .map((x) => ({ payDate: x.payDate, filingData: x.filingData as unknown as NlFilingData, ytd: x.ytd })),
      }),
    );
    return { bytes: await deps.pdf.document(doc), fileName };
  }

  const us = employer.usSettings;
  const result = engineCall('The W-2 builder', () =>
    deps.engines.formW2({
      employer: {
        name: employer.legalName,
        ein: us.ein ?? null,
        address: addressLines(employer.address, 'US'),
        depositSchedule: us.depositSchedule ?? 'monthly',
        states: Object.fromEntries(
          Object.entries(us.states ?? {}).map(([state, cfg]) => [state, { withholdingAccountNumber: cfg.withholdingAccountNumber ?? null, suiAccountNumber: cfg.suiAccountNumber ?? null }]),
        ),
      },
      // The employee copy: the SSN is masked.
      employee: { employeeId, name: displayNameOf(employee), ssn: maskSsn(sensitive.nationalId), address: addressLines(sensitive.homeAddress ?? null, 'US') },
      taxYear: year,
      payslips: slips
        .filter((x) => (x.filingData as { kind?: string }).kind === 'us')
        .map((x) => ({ payslipId: x.id, employeeId, payDate: x.payDate, filingData: x.filingData as unknown as UsFilingData })),
    }),
  );
  return { bytes: await deps.pdf.document(result.document), fileName };
}
