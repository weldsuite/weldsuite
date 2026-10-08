/**
 * Payroll journal import from a CSV export.
 *
 * Two shapes, picked by the mapping:
 *
 * - `summary`: one row per payroll with its totals (gross wages, employer
 *   taxes, employee withholdings, deductions, net pay, employer benefits ...).
 *   The entry is built from the account mapping; see journal.ts.
 * - `gl`: a general-ledger export (date, account, debit, credit, memo). Rows
 *   are grouped by date, one payroll per date; each export account is matched
 *   to the chart through the mapping, then by account code or name.
 *
 * The whole file is validated before anything is posted: a bad row stops the
 * import with every problem listed. Each payroll then posts on its own; one
 * already imported (same date and amounts) is reported, not posted twice.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { loadEntityAccounts, type EntityAccounts, type PostingLine } from '../accounting-posting';
import { isPayrollFailure } from './errors';
import { columnIndex, parseCsv, parseDate, parseMoney, type DateFormat } from './csv';
import { PayrollImportError, buildGlLines, buildPayrollLines, emptyTotals, summaryOf, type GlLine, type PayrollTotals } from './journal';
import { DuplicatePayrollError, postPayrollImport } from './imports';
import type { CsvMapping } from './mapping';

export interface CsvImportArgs {
  entityId: string;
  userId: string | null;
  csv: string;
  mapping: CsvMapping;
  periodStart?: string | null;
  periodEnd?: string | null;
  sourceFileName?: string | null;
  /** Mixed into the identity of each payroll; use it to import a payroll again after reversing it. */
  batchLabel?: string | null;
  /** Validate and build the entries without posting. */
  dryRun?: boolean;
}

export interface CsvImportedPayroll {
  /** Null for a dry run. */
  importId: string | null;
  payDate: string;
  journalEntryId: string | null;
  entryNumber: string | null;
  summary: Record<string, number>;
  totalDebit: number;
  lines: Array<{ accountId: string; debit: number; credit: number; description: string | null | undefined }>;
}

export interface CsvImportResult {
  shape: 'summary' | 'gl';
  dryRun: boolean;
  imports: CsvImportedPayroll[];
  /** Payrolls already imported: nothing was posted for them. */
  duplicates: Array<{ payDate: string; importId: string; status: string }>;
  /** Payrolls that could not be posted (a locked period, a missing account). */
  failed: Array<{ payDate: string; error: string }>;
}

export class PayrollCsvValidationError extends PayrollImportError {
  constructor(readonly problems: Array<{ row: number; message: string }>) {
    super(
      `The CSV has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ` +
        problems
          .slice(0, 5)
          .map((p) => `row ${p.row}: ${p.message}`)
          .join('; ') +
        (problems.length > 5 ? '; ...' : ''),
    );
    this.name = 'PayrollCsvValidationError';
  }
}

interface Prepared {
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  externalSeed: string;
  lines: PostingLine[];
  summary: Record<string, number>;
  description: string;
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

function requireColumn(headers: readonly string[], name: string | undefined, what: string): number {
  const index = columnIndex(headers, name);
  if (index < 0) {
    throw new PayrollImportError(`The CSV has no column "${name ?? ''}" (${what}). Columns found: ${headers.join(', ') || 'none'}`);
  }
  return index;
}

function amountAt(row: string[], index: number, label: string): number {
  if (index < 0) return 0;
  const value = parseMoney(row[index]);
  if (value !== null && value < 0) throw new RangeError(`${label} cannot be negative`);
  return value ?? 0;
}

// ---------------------------------------------------------------------------
// Summary shape

async function prepareSummary(
  rows: string[][],
  headers: string[],
  mapping: Extract<CsvMapping, { shape: 'summary' }>,
  accounts: EntityAccounts,
  args: CsvImportArgs,
): Promise<Prepared[]> {
  const c = mapping.columns;
  const at = {
    payDate: requireColumn(headers, c.payDate, 'pay date'),
    grossWages: requireColumn(headers, c.grossWages, 'gross wages'),
    netPay: requireColumn(headers, c.netPay, 'net pay'),
    employerTaxes: columnIndex(headers, c.employerTaxes),
    employeeTaxes: columnIndex(headers, c.employeeTaxes),
    employeeDeductions: columnIndex(headers, c.employeeDeductions),
    employerBenefits: columnIndex(headers, c.employerBenefits),
    reimbursements: columnIndex(headers, c.reimbursements),
    ownersDraw: columnIndex(headers, c.ownersDraw),
    periodStart: columnIndex(headers, c.periodStart),
    periodEnd: columnIndex(headers, c.periodEnd),
    reference: columnIndex(headers, c.reference),
  };
  for (const [key, name] of Object.entries(c)) {
    if (name && columnIndex(headers, name) < 0) throw new PayrollImportError(`The CSV has no column "${name}" (${key}). Columns found: ${headers.join(', ')}`);
  }

  const problems: Array<{ row: number; message: string }> = [];
  const prepared: Prepared[] = [];
  for (const [offset, row] of rows.entries()) {
    const rowNumber = offset + 2;
    try {
      const payDate = parseDate(row[at.payDate], mapping.dateFormat as DateFormat);
      if (!payDate) throw new RangeError(`"${row[at.payDate] ?? ''}" is not a date`);
      const totals: PayrollTotals = {
        ...emptyTotals(),
        grossWages: amountAt(row, at.grossWages, 'Gross wages'),
        netPay: amountAt(row, at.netPay, 'Net pay'),
        employerTaxes: amountAt(row, at.employerTaxes, 'Employer taxes'),
        employeeTaxes: amountAt(row, at.employeeTaxes, 'Employee taxes'),
        employeeDeductions: amountAt(row, at.employeeDeductions, 'Employee deductions'),
        employerBenefits: amountAt(row, at.employerBenefits, 'Employer benefits'),
        reimbursements: amountAt(row, at.reimbursements, 'Reimbursements'),
        ownersDraw: amountAt(row, at.ownersDraw, "Owner's draw"),
      };
      const reference = at.reference >= 0 ? (row[at.reference] ?? '').trim() : '';
      const lines = buildPayrollLines(totals, accounts, mapping.accounts, `Payroll ${payDate}`);
      prepared.push({
        payDate,
        periodStart: (at.periodStart >= 0 ? parseDate(row[at.periodStart], mapping.dateFormat as DateFormat) : null) ?? args.periodStart ?? null,
        periodEnd: (at.periodEnd >= 0 ? parseDate(row[at.periodEnd], mapping.dateFormat as DateFormat) : null) ?? args.periodEnd ?? null,
        externalSeed: JSON.stringify([payDate, reference, summaryOf(totals)]),
        lines,
        summary: summaryOf(totals),
        description: reference ? `Payroll ${payDate} (${reference})` : `Payroll ${payDate}`,
      });
    } catch (err) {
      if (err instanceof PayrollImportError || err instanceof RangeError) problems.push({ row: rowNumber, message: err.message });
      else throw err;
    }
  }
  if (problems.length > 0) throw new PayrollCsvValidationError(problems);
  return prepared;
}

// ---------------------------------------------------------------------------
// General-ledger shape

/** The chart account an export label stands for: the mapping, then an account code, then a name. */
function resolveAccountLabel(label: string, mapped: Record<string, string>, accounts: EntityAccounts, names: ReadonlyMap<string, string>): string | null {
  const wanted = label.trim();
  const direct = mapped[wanted];
  if (direct) return accounts.byId(direct) ? direct : null;
  const lower = wanted.toLowerCase();
  const key = Object.keys(mapped).find((candidate) => candidate.toLowerCase() === lower);
  if (key) return accounts.byId(mapped[key]) ? (mapped[key] as string) : null;
  const byCode = accounts.byCode(wanted) ?? accounts.byCode(wanted.split(/[\s:-]/, 1)[0] ?? '');
  if (byCode) return byCode.id;
  return names.get(lower) ?? null;
}

async function prepareGl(
  rows: string[][],
  headers: string[],
  mapping: Extract<CsvMapping, { shape: 'gl' }>,
  accounts: EntityAccounts,
  names: ReadonlyMap<string, string>,
  args: CsvImportArgs,
): Promise<Prepared[]> {
  const c = mapping.columns;
  const at = {
    date: requireColumn(headers, c.date, 'date'),
    account: requireColumn(headers, c.account, 'account'),
    debit: requireColumn(headers, c.debit, 'debit'),
    credit: requireColumn(headers, c.credit, 'credit'),
    memo: columnIndex(headers, c.memo),
  };
  const problems: Array<{ row: number; message: string }> = [];
  const byDate = new Map<string, Array<GlLine & { label: string }>>();
  for (const [offset, row] of rows.entries()) {
    const rowNumber = offset + 2;
    try {
      const payDate = parseDate(row[at.date], mapping.dateFormat as DateFormat);
      if (!payDate) throw new RangeError(`"${row[at.date] ?? ''}" is not a date`);
      const label = (row[at.account] ?? '').trim();
      if (!label) throw new RangeError('The account is empty');
      const accountId = resolveAccountLabel(label, mapping.accounts, accounts, names);
      if (!accountId) throw new RangeError(`No account matches "${label}"; map it to an account`);
      const debit = parseMoney(row[at.debit]) ?? 0;
      const credit = parseMoney(row[at.credit]) ?? 0;
      const group = byDate.get(payDate) ?? [];
      group.push({ accountId, debit, credit, memo: at.memo >= 0 ? (row[at.memo] ?? '').trim() || null : null, label });
      byDate.set(payDate, group);
    } catch (err) {
      if (err instanceof RangeError) problems.push({ row: rowNumber, message: err.message });
      else throw err;
    }
  }
  if (problems.length > 0) throw new PayrollCsvValidationError(problems);

  const prepared: Prepared[] = [];
  for (const [payDate, group] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let lines: PostingLine[];
    try {
      lines = buildGlLines(group, `Payroll ${payDate}`);
    } catch (err) {
      if (err instanceof PayrollImportError) throw new PayrollImportError(`${payDate}: ${err.message}`);
      throw err;
    }
    const summary: Record<string, number> = {};
    for (const line of group) summary[line.label] = Math.round(((summary[line.label] ?? 0) + line.debit - line.credit) * 100) / 100;
    prepared.push({
      payDate,
      periodStart: args.periodStart ?? null,
      periodEnd: args.periodEnd ?? null,
      externalSeed: JSON.stringify([payDate, group.map((line) => [line.accountId, line.debit, line.credit])]),
      lines,
      summary,
      description: `Payroll ${payDate}`,
    });
  }
  return prepared;
}

// ---------------------------------------------------------------------------

export async function importPayrollCsv(db: Database, args: CsvImportArgs): Promise<CsvImportResult> {
  const parsed = parseCsv(args.csv);
  if (parsed.headers.length === 0 || parsed.rows.length === 0) throw new PayrollImportError('The CSV is empty');
  const accounts = await loadEntityAccounts(db, args.entityId);
  const accountRows = await db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, args.entityId), isNull(schema.accounts.deletedAt)));
  const names = new Map(accountRows.map((row) => [row.name.trim().toLowerCase(), row.id]));

  const prepared =
    args.mapping.shape === 'summary'
      ? await prepareSummary(parsed.rows, parsed.headers, args.mapping, accounts, args)
      : await prepareGl(parsed.rows, parsed.headers, args.mapping, accounts, names, args);

  const result: CsvImportResult = { shape: args.mapping.shape, dryRun: Boolean(args.dryRun), imports: [], duplicates: [], failed: [] };
  const seen = new Set<string>();
  for (const item of prepared) {
    const externalId = `${item.payDate}:${await sha(`${item.externalSeed}|${args.batchLabel ?? ''}`)}`;
    if (seen.has(externalId)) {
      result.failed.push({ payDate: item.payDate, error: 'The CSV has this payroll twice (same date and amounts); add a reference column to tell them apart' });
      continue;
    }
    seen.add(externalId);

    const view = {
      payDate: item.payDate,
      summary: item.summary,
      totalDebit: Math.round(item.lines.reduce((sum, line) => sum + (line.debit ?? 0), 0) * 100) / 100,
      lines: item.lines.map((line) => ({ accountId: line.accountId, debit: line.debit ?? 0, credit: line.credit ?? 0, description: line.description })),
    };
    if (args.dryRun) {
      result.imports.push({ importId: null, journalEntryId: null, entryNumber: null, ...view });
      continue;
    }
    try {
      const posted = await postPayrollImport(db, {
        entityId: args.entityId,
        userId: args.userId,
        source: 'csv',
        externalId,
        payDate: item.payDate,
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        lines: item.lines,
        summary: item.summary,
        sourceFileName: args.sourceFileName ?? null,
        description: item.description,
      });
      result.imports.push({ importId: posted.importId, journalEntryId: posted.journalEntryId, entryNumber: posted.entryNumber, ...view });
    } catch (err) {
      if (err instanceof DuplicatePayrollError) {
        result.duplicates.push({ payDate: item.payDate, importId: err.existing.id, status: err.existing.status });
      } else if (isPayrollFailure(err)) {
        result.failed.push({ payDate: item.payDate, error: err.message });
      } else {
        throw err;
      }
    }
  }
  return result;
}

