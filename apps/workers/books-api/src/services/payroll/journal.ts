/**
 * The journal entry of one payroll.
 *
 * A payroll summary (from a CSV or from Gusto's totals) becomes:
 *
 *   Dr  Gross wages                       (wages expense)
 *   Dr  Employer payroll taxes            (payroll tax expense)
 *   Dr  Employer benefits                 (benefits expense, default the wages account)
 *   Dr  Expense reimbursements, owner's draw
 *     Cr  Employee taxes withheld         (payroll liabilities)
 *     Cr  Employee deductions             (payroll liabilities)
 *     Cr  Employer taxes + benefits owed  (payroll liabilities)
 *     Cr  Net pay + reimbursements + owner's draw   (bank or payroll clearing)
 *
 * It balances exactly when gross wages = net pay + employee taxes + employee
 * deductions; anything else is refused with the difference, never plugged.
 * Lines on the same account are merged.
 */

import { accountForRole, type EntityAccounts, type PostingLine } from '../accounting-posting';
import { PAYROLL_CATEGORIES, type AccountMapping, type PayrollCategory } from './mapping';

export class PayrollImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollImportError';
  }
}

export interface PayrollTotals {
  grossWages: number;
  employerTaxes: number;
  employerBenefits: number;
  reimbursements: number;
  ownersDraw: number;
  employeeTaxes: number;
  employeeDeductions: number;
  netPay: number;
}

export const emptyTotals = (): PayrollTotals => ({
  grossWages: 0,
  employerTaxes: 0,
  employerBenefits: 0,
  reimbursements: 0,
  ownersDraw: 0,
  employeeTaxes: 0,
  employeeDeductions: 0,
  netPay: 0,
});

const cents = (value: number): number => Math.round(value * 100 + (value >= 0 ? 1e-9 : -1e-9));
const amount = (value: number): number => value / 100;

/** The totals as the category → amount record stored on the import. */
export function summaryOf(totals: PayrollTotals): Record<string, number> {
  return {
    gross_wages: totals.grossWages,
    employer_taxes: totals.employerTaxes,
    employer_benefits: totals.employerBenefits,
    reimbursements: totals.reimbursements,
    owners_draw: totals.ownersDraw,
    employee_taxes: totals.employeeTaxes,
    employee_deductions: totals.employeeDeductions,
    net_pay: totals.netPay,
  };
}

interface Resolver {
  expense(category: PayrollCategory): string;
  liability(category: PayrollCategory): string;
  cash(): string;
}

function resolverFor(accounts: EntityAccounts, mapping: AccountMapping): Resolver {
  const mapped = (category: PayrollCategory): string | undefined => {
    const id = mapping[category];
    if (!id) return undefined;
    if (!accounts.byId(id)) throw new PayrollImportError(`The account mapped to ${category} does not belong to this accounting entity`);
    return id;
  };
  const wages = (): string | undefined => mapped('gross_wages') ?? accountForRole(accounts, 'payroll_wages_expense')?.id;
  const need = (id: string | undefined, category: PayrollCategory): string => {
    if (!id) throw new PayrollImportError(`Map an account for ${category} (${PAYROLL_CATEGORIES[category]}): this chart has no default for it`);
    return id;
  };
  return {
    expense(category) {
      switch (category) {
        case 'gross_wages':
          return need(wages(), category);
        case 'employer_taxes':
          return need(mapped(category) ?? accountForRole(accounts, 'payroll_tax_expense')?.id ?? wages(), category);
        case 'employer_benefits':
          return need(mapped(category) ?? wages(), category);
        case 'reimbursements':
          return need(mapped(category) ?? accountForRole(accounts, 'general_expense')?.id ?? wages(), category);
        case 'owners_draw':
          return need(mapped(category) ?? accountForRole(accounts, 'owner_draws')?.id, category);
        default:
          return need(mapped(category), category);
      }
    },
    liability(category) {
      return need(mapped(category) ?? mapped('payroll_liabilities') ?? accountForRole(accounts, 'payroll_liabilities')?.id, category);
    },
    cash() {
      return need(mapped('net_pay'), 'net_pay');
    },
  };
}

class LineBook {
  private readonly byKey = new Map<string, { accountId: string; debit: number; credit: number; labels: string[] }>();

  add(side: 'debit' | 'credit', accountId: string, value: number, label: string): void {
    if (value === 0) return;
    const key = `${side}:${accountId}`;
    const entry = this.byKey.get(key) ?? { accountId, debit: 0, credit: 0, labels: [] };
    entry[side] += value;
    if (!entry.labels.includes(label)) entry.labels.push(label);
    this.byKey.set(key, entry);
  }

  lines(prefix: string): PostingLine[] {
    const result: PostingLine[] = [];
    for (const entry of this.byKey.values()) {
      result.push({
        accountId: entry.accountId,
        ...(entry.debit > 0 ? { debit: amount(entry.debit) } : { credit: amount(entry.credit) }),
        description: `${prefix}: ${entry.labels.join(', ')}`,
      });
    }
    // Debits first, then credits, so the entry reads like a journal.
    return result.sort((a, b) => Number(Boolean(b.debit)) - Number(Boolean(a.debit)));
  }
}

/** Refuses totals that cannot be posted: negative or unbalanced. */
export function validateTotals(totals: PayrollTotals): void {
  for (const [name, value] of Object.entries(totals)) {
    if (!Number.isFinite(value)) throw new PayrollImportError(`${name} is not a number`);
    if (value < 0) throw new PayrollImportError(`${name} cannot be negative`);
  }
  const gross = cents(totals.grossWages);
  const paidOut = cents(totals.netPay) + cents(totals.employeeTaxes) + cents(totals.employeeDeductions);
  if (gross !== paidOut) {
    throw new PayrollImportError(
      `The payroll does not balance: gross wages ${amount(gross).toFixed(2)} must equal net pay + employee taxes + employee deductions (${amount(paidOut).toFixed(2)}); ` +
        `off by ${amount(gross - paidOut).toFixed(2)}.`,
    );
  }
  if (gross === 0 && cents(totals.ownersDraw) === 0) throw new PayrollImportError('The payroll has no amounts');
}

export function buildPayrollLines(
  totals: PayrollTotals,
  accounts: EntityAccounts,
  mapping: AccountMapping,
  label: string,
): PostingLine[] {
  validateTotals(totals);
  const resolve = resolverFor(accounts, mapping);
  const book = new LineBook();
  // Accounts are only looked up for amounts that exist, so a chart without a default for an unused category is fine.
  const debit = (category: PayrollCategory, value: number) => {
    if (cents(value) !== 0) book.add('debit', resolve.expense(category), cents(value), PAYROLL_CATEGORIES[category]);
  };
  const credit = (category: PayrollCategory, account: PayrollCategory, value: number) => {
    if (cents(value) !== 0) book.add('credit', resolve.liability(account), cents(value), PAYROLL_CATEGORIES[category]);
  };

  debit('gross_wages', totals.grossWages);
  debit('employer_taxes', totals.employerTaxes);
  debit('employer_benefits', totals.employerBenefits);
  debit('reimbursements', totals.reimbursements);
  debit('owners_draw', totals.ownersDraw);

  credit('employee_taxes', 'employee_taxes', totals.employeeTaxes);
  credit('employee_deductions', 'employee_deductions', totals.employeeDeductions);
  credit('employer_taxes', 'payroll_liabilities', totals.employerTaxes);
  credit('employer_benefits', 'payroll_liabilities', totals.employerBenefits);
  const cash = cents(totals.netPay) + cents(totals.reimbursements) + cents(totals.ownersDraw);
  if (cash !== 0) book.add('credit', resolve.cash(), cash, PAYROLL_CATEGORIES.net_pay);
  return book.lines(label);
}

/** One side of a GL export row, after the account label is resolved. */
export interface GlLine {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string | null;
}

/** Lines of a general-ledger export (one payroll's rows), checked for balance. */
export function buildGlLines(rows: readonly GlLine[], label: string): PostingLine[] {
  let debit = 0;
  let credit = 0;
  const lines: PostingLine[] = [];
  for (const row of rows) {
    const d = cents(row.debit);
    const c = cents(row.credit);
    if (d < 0 || c < 0) throw new PayrollImportError('Debit and credit amounts cannot be negative');
    if (d === 0 && c === 0) continue;
    debit += d;
    credit += c;
    lines.push({
      accountId: row.accountId,
      ...(d > 0 ? { debit: amount(d) } : {}),
      ...(c > 0 ? { credit: amount(c) } : {}),
      description: row.memo ? `${label}: ${row.memo}` : label,
    });
  }
  if (lines.length === 0) throw new PayrollImportError('The payroll has no amounts');
  if (debit !== credit) {
    throw new PayrollImportError(`The payroll does not balance: debits ${amount(debit).toFixed(2)}, credits ${amount(credit).toFixed(2)} (off by ${amount(debit - credit).toFixed(2)})`);
  }
  return lines;
}
