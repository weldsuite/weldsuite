/**
 * The journal of a WeldHR pay run (source `weldhr`).
 *
 * WeldHR sends the run's totals; this turns them into one balanced entry the
 * same way a Gusto payroll becomes one (journal.ts), with two differences:
 *
 *  - amounts are signed: a correction run can come out negative (an employee
 *    was overpaid), and a negative amount posts on the opposite side;
 *  - nobody maps accounts for it, so the defaults come from the chart: the
 *    payroll system roles, falling back to the well-known template codes for
 *    entities created before the roles existed, and the entity's bank
 *    account for net pay.
 */

import type { PostingLine, EntityAccounts } from '../accounting-posting';
import { resolverFor } from './journal';
import { PayrollImportError } from './journal';
import { PAYROLL_CATEGORIES, type AccountMapping, type PayrollCategory } from './mapping';

export interface WeldHrTotals {
  grossWages: number;
  employerTaxes: number;
  employerBenefits: number;
  reimbursements: number;
  employeeTaxes: number;
  employeeDeductions: number;
  /** Net pay excluding reimbursements: gross - employee taxes - employee deductions. */
  netPay: number;
}

const cents = (value: number): number => Math.round(value * 100 + (value >= 0 ? 1e-9 : -1e-9));
const amount = (value: number): number => value / 100;

/** The totals as the category → amount record stored on the import. */
export function weldHrSummary(totals: WeldHrTotals): Record<string, number> {
  return {
    gross_wages: totals.grossWages,
    employer_taxes: totals.employerTaxes,
    employer_benefits: totals.employerBenefits,
    reimbursements: totals.reimbursements,
    employee_taxes: totals.employeeTaxes,
    employee_deductions: totals.employeeDeductions,
    net_pay: totals.netPay,
  };
}

/**
 * Accounts for the categories the caller did not map: system roles first, then
 * the well-known chart codes, then (net pay) the entity's bank account.
 */
export function resolveWeldHrMapping(accounts: EntityAccounts, country: 'NL' | 'US', requested: AccountMapping = {}): AccountMapping {
  const mapping: AccountMapping = { ...requested };
  const fill = (category: PayrollCategory, ...candidates: Array<string | undefined>) => {
    if (mapping[category]) return;
    const id = candidates.find((candidate): candidate is string => Boolean(candidate));
    if (id) mapping[category] = id;
  };
  const byRole = (role: string) => accounts.byRole(role)?.id;
  const byCode = (code: string) => accounts.byCode(code)?.id;

  if (country === 'NL') {
    fill('gross_wages', byRole('payroll_wages_expense'), byCode('4110'));
    fill('employer_taxes', byRole('payroll_tax_expense'), byCode('4120'));
    fill('employer_benefits', byCode('4130'));
    fill('payroll_liabilities', byRole('payroll_liabilities'), byCode('1800'));
    fill('net_pay', byCode('1100'), accounts.bySubtype('bank')?.id);
  } else {
    fill('gross_wages', byRole('payroll_wages_expense'));
    fill('employer_taxes', byRole('payroll_tax_expense'));
    fill('payroll_liabilities', byRole('payroll_liabilities'));
    fill('net_pay', byCode('1000'), accounts.bySubtype('bank')?.id);
  }
  return mapping;
}

class SignedBook {
  private readonly byKey = new Map<string, { accountId: string; debit: number; credit: number; labels: string[] }>();

  /** `side` is the normal side of the category; a negative amount lands on the other one. */
  add(side: 'debit' | 'credit', accountId: string, signedCents: number, label: string): void {
    if (signedCents === 0) return;
    const actual = signedCents > 0 ? side : side === 'debit' ? 'credit' : 'debit';
    const value = Math.abs(signedCents);
    const key = `${actual}:${accountId}`;
    const entry = this.byKey.get(key) ?? { accountId, debit: 0, credit: 0, labels: [] };
    entry[actual] += value;
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
    return result.sort((a, b) => Number(Boolean(b.debit)) - Number(Boolean(a.debit)));
  }
}

/** Refuses totals that cannot be posted: not numbers, unbalanced, or empty. */
export function validateWeldHrTotals(totals: WeldHrTotals): void {
  for (const [name, value] of Object.entries(totals)) {
    if (!Number.isFinite(value)) throw new PayrollImportError(`${name} is not a number`);
  }
  const gross = cents(totals.grossWages);
  const paidOut = cents(totals.netPay) + cents(totals.employeeTaxes) + cents(totals.employeeDeductions);
  if (gross !== paidOut) {
    throw new PayrollImportError(
      `The payroll does not balance: gross wages ${amount(gross).toFixed(2)} must equal net pay + employee taxes + employee deductions (${amount(paidOut).toFixed(2)}); off by ${amount(gross - paidOut).toFixed(2)}.`,
    );
  }
  const anything = Object.values(totals).some((value) => cents(value) !== 0);
  if (!anything) throw new PayrollImportError('The payroll has no amounts');
}

export function buildWeldHrLines(totals: WeldHrTotals, accounts: EntityAccounts, mapping: AccountMapping, label: string): PostingLine[] {
  validateWeldHrTotals(totals);
  const resolve = resolverFor(accounts, mapping);
  const book = new SignedBook();
  // Accounts are only looked up for amounts that exist, so a chart without a default for an unused category is fine.
  const expense = (category: PayrollCategory, value: number) => {
    if (cents(value) !== 0) book.add('debit', resolve.expense(category), cents(value), PAYROLL_CATEGORIES[category]);
  };
  const owed = (category: PayrollCategory, liability: PayrollCategory, value: number) => {
    if (cents(value) !== 0) book.add('credit', resolve.liability(liability), cents(value), PAYROLL_CATEGORIES[category]);
  };

  expense('gross_wages', totals.grossWages);
  expense('employer_taxes', totals.employerTaxes);
  expense('employer_benefits', totals.employerBenefits);
  expense('reimbursements', totals.reimbursements);

  owed('employee_taxes', 'employee_taxes', totals.employeeTaxes);
  owed('employee_deductions', 'employee_deductions', totals.employeeDeductions);
  owed('employer_taxes', 'payroll_liabilities', totals.employerTaxes);
  owed('employer_benefits', 'payroll_liabilities', totals.employerBenefits);
  const cash = cents(totals.netPay) + cents(totals.reimbursements);
  if (cash !== 0) book.add('credit', resolve.cash(), cash, PAYROLL_CATEGORIES.net_pay);
  return book.lines(label);
}
