/**
 * Files a pay run produces for the employer: the salary payment file (SEPA
 * pain.001 for NL, NACHA for US; the employer uploads it to its own bank, we
 * never move money) and a CSV of every payslip line.
 *
 * Builder errors (an invalid IBAN, a routing number that fails its checksum…)
 * come back as a 422 whose `error.details.issues` are structured
 * `HrPayrollIssue`s, with the employee attached where the builder named the
 * payment; nothing is handed out.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { HrPayrollFilingTaxPayment, HrPayrollIssue } from '@weldsuite/db/schema';
import { payslipLineLabel } from '@weldsuite/payroll-domain/labels';
import { fromCents, toCents } from '@weldsuite/payroll-domain/money';
import type { GeneratedFile } from '@weldsuite/payroll-domain/documents';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { displayNameOf } from '../employees';
import { HrNotFoundError, HrPayrollError } from '../shared';
import { csvRow, num, type EmployerRow, type PayslipRow, type RunRow } from './common';
import type { PayrollDeps } from './deps';
import { maxDate } from './dates';
import { bankOf, decryptSensitive, openBank, sameBank, type PayrollBank } from './employees';
import { readEmployerBank } from './employers';
import { engineCall, safeId, salaryRemittance } from './format';
import { incomplete, invalidWith, structuredIssues } from './issues';
import { languageOf } from './payslips';
import { requireRun } from './runs';

const s = schema.hrPayslips;

function assertPayable(run: RunRow) {
  if (run.status !== 'approved' && run.status !== 'paid') {
    throw new HrPayrollError('RUN_NOT_APPROVED', 'The payment file is available once the run is approved', 409);
  }
}

/** Today's date as the file's execution date floor: a bank refuses a date in the past. */
function executionDate(payDate: string, now: Date): string {
  return maxDate(payDate, now.toISOString().slice(0, 10));
}

/** 409: employees without bank details, as structured issues per employee. */
function missingBankAccounts(message: string, employeeIds: string[]): HrPayrollError {
  return new HrPayrollError('MISSING_BANK_ACCOUNT', message, 409, {
    employeeIds,
    issues: employeeIds.map((employeeId) => ({ severity: 'error' as const, code: 'missing_bank_account', employeeId })),
  });
}

/** The payment file, plus warnings the caller should log or audit (they never block the file). */
export type PaymentFile = GeneratedFile & { warnings: HrPayrollIssue[] };

export async function buildPaymentFile(db: Database, runId: string, deps: PayrollDeps): Promise<PaymentFile> {
  const run = await requireRun(db, runId);
  assertPayable(run);
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, run.employerId)).limit(1);
  if (!employer) throw new HrNotFoundError('Payroll employer', run.employerId);
  const bank = await readEmployerBank(employer, deps.keyring);

  // What can be paid: positive net pay. (A correction can come out negative: that is recovered another way.)
  const slips = (await db.select().from(s).where(and(eq(s.runId, runId), eq(s.status, 'final')))).filter((x) => toCents(x.netPay) > 0);
  if (slips.length === 0) throw new HrPayrollError('NOTHING_TO_PAY', 'This run has no payments to make', 409);
  const people = await db
    .select()
    .from(schema.hrEmployees)
    .where(inArray(schema.hrEmployees.id, slips.map((x) => x.employeeId)));
  const personById = new Map(people.map((p) => [p.id, p]));

  // Each payslip is paid to the account that was approved (sealed in its snapshot), not to whatever the employee's
  // details say now: otherwise a change of IBAN after a four-eyes approval would redirect the salary. A difference
  // is reported as a warning; the approved account is still the one paid.
  const sensitiveById: SensitiveMap = new Map();
  const warnings: HrPayrollIssue[] = [];
  for (const slip of slips) {
    const person = personById.get(slip.employeeId);
    const current = person ? bankOf(await decryptSensitive(person, deps.keyring)) : null;
    const sealed = (slip.snapshot as { bankEncrypted?: string | null }).bankEncrypted;
    if (sealed) {
      const approved = await openBank(sealed, deps.keyring);
      if (!sameBank(approved, current)) {
        warnings.push({ severity: 'warning', code: 'bank_changed_after_approval', employeeId: slip.employeeId });
        console.warn(`[payroll] the bank details of employee ${slip.employeeId} changed after run ${run.id} was approved; the payment file uses the approved account`);
      }
      sensitiveById.set(slip.employeeId, approved);
    } else {
      // Approved before the account was sealed (or without one): the current details are all there is.
      sensitiveById.set(slip.employeeId, current ?? {});
    }
  }

  const file =
    employer.country === 'NL'
      ? await buildSepa(db, run, employer, bank, slips, personById, sensitiveById, deps)
      : await buildNacha(run, employer, bank, slips, personById, sensitiveById, deps);
  return { ...file, warnings };
}

type PersonMap = Map<string, typeof schema.hrEmployees.$inferSelect>;
type SensitiveMap = Map<string, PayrollBank>;

const CARRYING_STATUSES = ['ready', 'submitted', 'accepted', 'filed'];

/**
 * The loonheffingen of the PREVIOUS month are due by the end of this one, so
 * they ride along with the salaries when that month's return has been generated
 * (it carries the betalingskenmerk and the amount due). They ride in exactly one
 * run's file: the first file built after the return is ready claims the amount
 * (recorded on the filing's `taxPayments`), and that run's file carries it
 * again whenever it is downloaded again. Another run in the same month adds
 * nothing, and neither does a return that a correction reopened and that has not
 * been generated again (its amount is stale). A regenerated return (a new
 * version) only carries what earlier files did not: its amount due minus what
 * was already carried, by the next file built that carried nothing of it yet.
 */
async function taxPaymentFor(db: Database, run: RunRow, employer: EmployerRow): Promise<{ amountCents: number; betalingskenmerk: string } | null> {
  if (run.kind === 'correction') return null;
  const f = schema.hrPayrollFilings;
  const month = Number(run.payDate.slice(5, 7));
  const year = Number(run.payDate.slice(0, 4));
  const [filing] = await db
    .select()
    .from(f)
    .where(
      and(
        eq(f.employerId, employer.id),
        eq(f.kind, 'nl_loonaangifte'),
        eq(f.taxYear, month === 1 ? year - 1 : year),
        eq(f.period, month === 1 ? 12 : month - 1),
      ),
    )
    .limit(1);
  if (!filing) return null;

  const entries: HrPayrollFilingTaxPayment[] = filing.taxPayments ?? [];
  // This run's file carried it before: it carries it again.
  const mine = entries.filter((e) => e.runId === run.id);
  if (mine.length) return { amountCents: mine.reduce((n, e) => n + e.cents, 0), betalingskenmerk: mine[0]!.reference };

  if (!CARRYING_STATUSES.includes(filing.status) || !filing.generatedAt || !filing.paymentReference) return null;
  // What is still owed: the return's amount minus what earlier files already carried (nothing left, or a lower new
  // amount, carries nothing: the tax authority settles the difference itself).
  const amountCents = toCents(filing.amountDue) - entries.reduce((n, e) => n + e.cents, 0);
  if (amountCents <= 0) return null;

  const next: HrPayrollFilingTaxPayment[] = [...entries, { runId: run.id, version: filing.version, cents: amountCents, reference: filing.paymentReference }];
  const claimed = await db
    .update(f)
    .set({ taxPayments: next })
    .where(and(eq(f.id, filing.id), eq(f.version, filing.version), inArray(f.status, CARRYING_STATUSES), sql`${f.taxPayments} = ${JSON.stringify(entries)}::jsonb`))
    .returning({ id: f.id });
  // Another file claimed it between the read and the write: that one carries it.
  if (claimed.length === 0) return null;
  return { amountCents, betalingskenmerk: filing.paymentReference };
}

async function buildSepa(
  db: Database,
  run: RunRow,
  employer: EmployerRow,
  bank: Awaited<ReturnType<typeof readEmployerBank>>,
  slips: PayslipRow[],
  people: PersonMap,
  sensitive: SensitiveMap,
  deps: PayrollDeps,
): Promise<GeneratedFile> {
  if (!bank?.iban) throw incomplete('The employer has no bank account (IBAN) to pay salaries from', 'bank_iban');
  const lang = languageOf(employer);
  const missing = slips.filter((x) => !sensitive.get(x.employeeId)?.bankIban).map((x) => x.employeeId);
  if (missing.length) throw missingBankAccounts('Some employees have no IBAN', missing);

  const tax = await taxPaymentFor(db, run, employer);

  // The builder names a payment by the id it was given (the payslip id): attach the employee to its issues.
  const sepaIdOf = (slipId: string) => safeId(slipId).slice(0, 35);
  const employeeOfPayslip = new Map(slips.map((x) => [sepaIdOf(x.id), x.employeeId]));
  const attribution = (_key: string, value: string | number) => employeeOfPayslip.get(String(value));
  const result = engineCall('The SEPA salary file builder', () =>
    deps.engines.buildSepaSalaryBatch({
      messageId: `SAL-${safeId(run.id)}`.slice(0, 35),
      createdAt: deps.now().toISOString(),
      executionDate: executionDate(run.payDate, deps.now()),
      debtor: { name: bank.accountHolder ?? employer.legalName, iban: bank.iban!, bic: bank.bic ?? null },
      salaries: slips.map((slip) => {
        const person = people.get(slip.employeeId)!;
        const sens = sensitive.get(slip.employeeId)!;
        return {
          endToEndId: sepaIdOf(slip.id),
          creditor: { name: sens.bankAccountHolder ?? displayNameOf(person), iban: sens.bankIban!, bic: sens.bankBic ?? null },
          amountCents: toCents(slip.netPay),
          remittance: salaryRemittance(run.periodStart, lang),
        };
      }),
      tax,
    }),
  );
  const issues = structuredIssues(result.issues, attribution);
  if (issues.some((i) => i.severity === 'error')) throw invalidWith('PAYMENT_FILE_INVALID', 'The salary file has errors and was not produced', issues);
  return { fileName: result.fileName, contentType: result.contentType, content: result.content };
}

async function buildNacha(
  run: RunRow,
  employer: EmployerRow,
  bank: Awaited<ReturnType<typeof readEmployerBank>>,
  slips: PayslipRow[],
  people: PersonMap,
  sensitive: SensitiveMap,
  deps: PayrollDeps,
): Promise<GeneratedFile> {
  if (!bank?.routingNumber || !bank.accountNumber || !bank.nachaCompanyId) {
    throw incomplete(
      'The employer needs a routing number, account number and NACHA company id to produce an ACH file',
      !bank?.routingNumber ? 'bank_routing' : !bank.accountNumber ? 'bank_account' : 'nacha_company_id',
    );
  }
  const missing = slips.filter((x) => {
    const sens = sensitive.get(x.employeeId);
    return !sens?.bankRoutingNumber || !sens.bankAccountNumber;
  });
  if (missing.length) throw missingBankAccounts('Some employees have no bank account', missing.map((x) => x.employeeId));

  // The builder names a credit by its individual id: attach the employee to its issues.
  const employeeOfIndividual = new Map<string, string>();
  const credits = slips.map((slip) => {
    const person = people.get(slip.employeeId)!;
    const sens = sensitive.get(slip.employeeId)!;
    const individualId = (person.employeeNumber ?? slip.id.slice(-15)).slice(0, 15);
    employeeOfIndividual.set(individualId, slip.employeeId);
    return {
      individualId,
      individualName: displayNameOf(person).slice(0, 22),
      routingNumber: sens.bankRoutingNumber!,
      accountNumber: sens.bankAccountNumber!,
      accountType: sens.bankAccountType ?? ('checking' as const),
      amountCents: toCents(slip.netPay),
    };
  });
  const attribution = (_key: string, value: string | number) => employeeOfIndividual.get(String(value));
  const result = engineCall('The NACHA file builder', () =>
    deps.engines.buildNachaFile({
      originator: { companyName: employer.name.slice(0, 16), companyId: bank.nachaCompanyId!, odfiRouting: bank.routingNumber!, odfiName: (bank.bankName ?? '').slice(0, 23) },
      effectiveDate: executionDate(run.payDate, deps.now()),
      createdAt: deps.now().toISOString(),
      credits,
    }),
  );
  const issues = structuredIssues(result.issues, attribution);
  if (issues.some((i) => i.severity === 'error')) throw invalidWith('PAYMENT_FILE_INVALID', 'The ACH file has errors and was not produced', issues);
  return { fileName: result.fileName, contentType: result.contentType, content: result.content };
}

/** One CSV row per payslip line of the run. */
export async function buildRunReport(db: Database, runId: string): Promise<GeneratedFile> {
  const run = await requireRun(db, runId);
  const [employer] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, run.employerId)).limit(1);
  const lang = employer ? languageOf(employer) : 'en';
  const slips = await db.select().from(s).where(eq(s.runId, runId));
  const people = slips.length
    ? await db.select().from(schema.hrEmployees).where(inArray(schema.hrEmployees.id, slips.map((x) => x.employeeId)))
    : [];
  const nameOf = new Map(people.map((p) => [p.id, displayNameOf(p)]));

  const rows = [
    csvRow(['employee', 'employee_id', 'payslip_number', 'status', 'section', 'code', 'label', 'quantity', 'rate', 'amount', 'currency']),
  ];
  for (const slip of [...slips].sort((a, b) => (nameOf.get(a.employeeId) ?? '').localeCompare(nameOf.get(b.employeeId) ?? ''))) {
    for (const line of slip.lines) {
      rows.push(
        csvRow([
          nameOf.get(slip.employeeId) ?? '',
          slip.employeeId,
          slip.number,
          slip.status,
          line.section,
          line.code,
          payslipLineLabel(line, lang),
          num(line.quantity ?? null),
          num(line.rate ?? null),
          fromCents(line.amountCents),
          slip.currency,
        ]),
      );
    }
  }
  return { fileName: `payroll-${run.periodStart}-${run.periodEnd}.csv`, contentType: 'text/csv; charset=utf-8', content: `${rows.join('\r\n')}\r\n` };
}
