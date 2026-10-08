/**
 * Deposit arithmetic for the "Make deposit" page. Amounts are added in whole
 * cents so the total shown is the total the server posts.
 */
import {
  isLiabilityAccountType,
  type CreateDepositInput,
  type UndepositedPayment,
  type UsBankAccount,
} from '@/lib/api/domains/weldbooks-banking';

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

/** Sum of amounts, exact to the cent. */
export function sumAmounts(amounts: readonly number[]): number {
  return fromCents(amounts.reduce((total, amount) => total + toCents(amount), 0));
}

export function sumUndeposited(rows: readonly Pick<UndepositedPayment, 'amount'>[]): number {
  return sumAmounts(rows.map((r) => r.amount));
}

/** A typed amount such as `1,234.56`, `-20` or `(20.00)`; null when it isn't a number. */
export function parseMoneyInput(text: string): number | null {
  let value = text.trim().replaceAll(/[$,\s]/g, '');
  if (!value) return null;
  let negative = false;
  if (value.startsWith('(') && value.endsWith(')')) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (value.startsWith('-')) {
    negative = !negative;
    value = value.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(value)) return null;
  const parsed = Number.parseFloat(value);
  return negative ? -parsed : parsed;
}

/** An extra line on the deposit slip, as typed. */
export interface OtherLineDraft {
  /** Local key for the row. */
  key: string;
  accountId: string;
  /** Positive adds money to the deposit (a refund received), negative is cash back. */
  amount: string;
  description: string;
}

export interface DepositTotals {
  paymentsTotal: number;
  otherTotal: number;
  total: number;
}

export function computeDepositTotals(
  selected: readonly Pick<UndepositedPayment, 'amount'>[],
  otherLines: readonly Pick<OtherLineDraft, 'amount'>[],
): DepositTotals {
  const paymentsTotal = sumUndeposited(selected);
  const otherTotal = sumAmounts(otherLines.map((l) => parseMoneyInput(l.amount) ?? 0));
  return { paymentsTotal, otherTotal, total: sumAmounts([paymentsTotal, otherTotal]) };
}

export type DepositProblem = 'bankAccount' | 'date' | 'nothing' | 'otherLineAccount' | 'otherLineAmount' | 'total';

export function depositProblems(args: {
  bankAccountId: string;
  date: string;
  selectedCount: number;
  otherLines: readonly OtherLineDraft[];
  totals: DepositTotals;
}): DepositProblem[] {
  const problems: DepositProblem[] = [];
  if (!args.bankAccountId) problems.push('bankAccount');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) problems.push('date');
  if (args.selectedCount === 0 && args.otherLines.length === 0) problems.push('nothing');
  if (args.otherLines.some((l) => !l.accountId)) problems.push('otherLineAccount');
  if (args.otherLines.some((l) => {
    const amount = parseMoneyInput(l.amount);
    return amount === null || amount === 0;
  })) problems.push('otherLineAmount');
  // A deposit can't take money out of the bank.
  if (args.selectedCount + args.otherLines.length > 0 && !(args.totals.total > 0)) problems.push('total');
  return problems;
}

/** The request for the page's state; the caller has checked `depositProblems` is empty. */
export function buildDepositInput(args: {
  bankAccountId: string;
  date: string;
  memo: string;
  paymentIds: readonly string[];
  otherLines: readonly OtherLineDraft[];
}): CreateDepositInput {
  const memo = args.memo.trim();
  return {
    bankAccountId: args.bankAccountId,
    date: args.date,
    paymentIds: [...args.paymentIds],
    ...(args.otherLines.length > 0
      ? {
          otherLines: args.otherLines.map((l) => ({
            accountId: l.accountId,
            amount: parseMoneyInput(l.amount) ?? 0,
            ...(l.description.trim() ? { description: l.description.trim() } : {}),
          })),
        }
      : {}),
    ...(memo ? { memo } : {}),
  };
}

/** Bank accounts a deposit can go to: checking, savings and money market, not cards or credit lines. */
export function depositBankAccounts(accounts: readonly UsBankAccount[]): UsBankAccount[] {
  return accounts.filter((a) => a.isActive !== false && !isLiabilityAccountType(a.accountType));
}
