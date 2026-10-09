import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import type {
  BalanceSheetReport,
  ProfitLossReport,
  ReportAccountRow,
  ReportColumn,
  TrialBalanceReport,
  ValueSet,
} from '@/lib/weldbooks/report-types';
import {
  applyParamsPatch,
  balanceSheetRows,
  bucketCount,
  bucketTotal,
  columnHeading,
  EMPTY_REPORT_PARAMS,
  isComparing,
  profitLossRows,
  toReportQuery,
  trialBalanceRows,
} from './report-model';

const statement = en.weldbooksUs.reports.statement;

const current: ReportColumn = { key: 'current', label: '2026-01-01 to 2026-12-31', from: '2026-01-01', to: '2026-12-31' };
const prior: ReportColumn = { key: 'prior', label: '2025-01-01 to 2025-12-31', from: '2025-01-01', to: '2025-12-31' };

function set(currentValue: string, priorValue?: string): ValueSet {
  if (priorValue === undefined) return { values: { current: currentValue } };
  const delta = Number(currentValue) - Number(priorValue);
  return {
    values: { current: currentValue, prior: priorValue },
    delta: { amount: delta.toFixed(2), percent: Number(priorValue) === 0 ? null : Math.round((delta / Math.abs(Number(priorValue))) * 1000) / 10 },
  };
}

function account(
  id: string | null,
  code: string,
  name: string,
  type: 'revenue' | 'expense' | 'asset' | 'liability' | 'equity',
  amounts: [string, string?],
  extra: Partial<ReportAccountRow> = {},
): ReportAccountRow {
  return {
    accountId: id,
    accountCode: code,
    accountName: name,
    accountType: type,
    accountSubtype: null,
    normalSide: type === 'revenue' || type === 'liability' || type === 'equity' ? 'credit' : 'debit',
    totalDebit: '0.00',
    totalCredit: '0.00',
    balance: amounts[0],
    ...set(amounts[0], amounts[1]),
    ...extra,
  };
}

const profitLoss = (comparing: boolean): ProfitLossReport => ({
  basis: 'accrual',
  period: { from: '2026-01-01', to: '2026-12-31' },
  columns: comparing ? [current, prior] : [current],
  revenue: [
    account('acc_sales', '4000', 'Sales', 'revenue', ['1000.00', comparing ? '800.00' : undefined], { section: 'income' }),
    account('acc_interest', '4900', 'Interest income', 'revenue', ['10.00', comparing ? '0.00' : undefined], { section: 'other_income' }),
  ],
  expenses: [
    account('acc_cogs', '5000', 'Materials', 'expense', ['300.00', comparing ? '250.00' : undefined], { section: 'cost_of_goods_sold' }),
    account('acc_rent', '6000', 'Rent', 'expense', ['200.00', comparing ? '200.00' : undefined], { section: 'expense' }),
  ],
  totalRevenue: '1010.00',
  totalExpenses: '500.00',
  netProfit: '510.00',
  totals: {
    income: set('1000.00', comparing ? '800.00' : undefined),
    costOfGoodsSold: set('300.00', comparing ? '250.00' : undefined),
    grossProfit: set('700.00', comparing ? '550.00' : undefined),
    expenses: set('200.00', comparing ? '200.00' : undefined),
    netOperatingIncome: set('500.00', comparing ? '350.00' : undefined),
    otherIncome: set('10.00', comparing ? '0.00' : undefined),
    otherExpenses: set('0.00', comparing ? '0.00' : undefined),
    netOtherIncome: set('10.00', comparing ? '0.00' : undefined),
    totalRevenue: set('1010.00', comparing ? '800.00' : undefined),
    totalExpenses: set('500.00', comparing ? '450.00' : undefined),
    netProfit: set('510.00', comparing ? '350.00' : undefined),
  },
});

describe('profitLossRows', () => {
  it('lays out income, cost of goods sold, gross profit, expenses and the net lines from the totals', () => {
    const rows = profitLossRows(profitLoss(false), statement);
    expect(rows.map((r) => `${r.kind}:${r.label}`)).toEqual([
      'section:Income',
      'account:Sales',
      'subtotal:Total income',
      'section:Cost of goods sold',
      'account:Materials',
      'subtotal:Total cost of goods sold',
      'total:Gross profit',
      'section:Expenses',
      'account:Rent',
      'subtotal:Total expenses',
      'total:Net operating income',
      'section:Other income',
      'account:Interest income',
      'subtotal:Total other income',
      'total:Net other income',
      'total:Net income',
    ]);
    expect(rows.find((r) => r.label === 'Gross profit')?.values.current).toBe('700.00');
    expect(rows.find((r) => r.label === 'Net income')?.values.current).toBe('510.00');
  });

  it('leaves out cost of goods sold and the other blocks when the books have none', () => {
    const report = profitLoss(false);
    report.revenue = report.revenue.filter((r) => r.section === 'income');
    report.expenses = report.expenses.filter((r) => r.section === 'expense');
    const labels = profitLossRows(report, statement).map((r) => r.label);
    expect(labels).not.toContain('Gross profit');
    expect(labels).not.toContain('Other income');
    expect(labels).toContain('Net operating income');
  });

  it('carries the prior value and the change of a comparison on every row', () => {
    const rows = profitLossRows(profitLoss(true), statement);
    const sales = rows.find((r) => r.label === 'Sales');
    expect(sales?.values).toEqual({ current: '1000.00', prior: '800.00' });
    expect(sales?.delta).toEqual({ amount: '200.00', percent: 25 });
    expect(rows.find((r) => r.label === 'Net income')?.delta?.amount).toBe('160.00');
    // A zero prior amount has no percentage.
    expect(rows.find((r) => r.label === 'Interest income')?.delta?.percent).toBeNull();
  });

  it('links an account row to its account and a total row to nothing', () => {
    const rows = profitLossRows(profitLoss(false), statement);
    expect(rows.find((r) => r.label === 'Sales')?.accountId).toBe('acc_sales');
    expect(rows.find((r) => r.label === 'Net income')?.accountId).toBeUndefined();
  });
});

describe('balanceSheetRows', () => {
  const sheet: BalanceSheetReport = {
    basis: 'accrual',
    asOf: '2026-12-31',
    columns: [current],
    assets: [account('acc_bank', '1000', 'Bank', 'asset', ['500.00'])],
    liabilities: [account('acc_ap', '2000', 'Accounts payable', 'liability', ['100.00'])],
    equity: [
      account('acc_capital', '3000', 'Owner capital', 'equity', ['100.00']),
      account(null, '', 'Retained earnings (earlier years)', 'equity', ['150.00'], {
        virtual: true,
        accountSubtype: 'calculated_retained_earnings',
      }),
      account(null, '', 'Net income (this fiscal year)', 'equity', ['150.00'], {
        virtual: true,
        accountSubtype: 'calculated_net_income',
      }),
    ],
    totalAssets: '500.00',
    totalLiabilities: '100.00',
    totalEquity: '400.00',
    totalLiabilitiesAndEquity: '500.00',
    difference: '0.00',
    isBalanced: true,
    totals: {
      assets: set('500.00'),
      liabilities: set('100.00'),
      equity: set('400.00'),
      liabilitiesAndEquity: set('500.00'),
    },
  };
  const labels = {
    ...statement,
    calculated: {
      calculated_retained_earnings: 'Winst van eerdere jaren',
      calculated_net_income: 'Resultaat dit jaar',
    },
  };

  it('keeps the calculated equity rows without an account link and names them in the page language', () => {
    const rows = balanceSheetRows(sheet, labels);
    const virtual = rows.filter((r) => r.kind === 'account' && !r.accountId);
    expect(virtual.map((r) => r.label)).toEqual(['Winst van eerdere jaren', 'Resultaat dit jaar']);
    expect(virtual.every((r) => r.code === null)).toBe(true);
    expect(rows.find((r) => r.label === 'Owner capital')?.accountId).toBe('acc_capital');
  });

  it('closes with total liabilities and equity', () => {
    const rows = balanceSheetRows(sheet, labels);
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ kind: 'total', label: 'Total liabilities and equity' });
    expect(last.values.current).toBe('500.00');
  });
});

describe('trialBalanceRows', () => {
  const trial = (columns: ReportColumn[]): TrialBalanceReport => ({
    basis: 'accrual',
    period: { from: '2026-01-01', to: '2026-12-31' },
    columns,
    accounts: [
      {
        accountId: 'acc_bank',
        accountCode: '1000',
        accountName: 'Bank',
        accountType: 'asset',
        totalDebit: '500.00',
        totalCredit: '0.00',
        debitBalance: '500.00',
        creditBalance: '0.00',
        ...set('500.00', columns.length === 2 ? '300.00' : undefined),
      },
      {
        accountId: 'acc_sales',
        accountCode: '4000',
        accountName: 'Sales',
        accountType: 'revenue',
        totalDebit: '0.00',
        totalCredit: '500.00',
        debitBalance: '0.00',
        creditBalance: '500.00',
        ...set('-500.00', columns.length === 2 ? '-300.00' : undefined),
      },
    ],
    totalDebit: '500.00',
    totalCredit: '500.00',
    isBalanced: true,
  });

  it('shows debit and credit columns with a total for a single period', () => {
    const { rows, debitCredit } = trialBalanceRows(trial([current]), { total: 'Totals' });
    expect(debitCredit).toBe(true);
    expect(rows[0].values).toEqual({ debit: '500.00', credit: '0.00' });
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'total', label: 'Totals', values: { debit: '500.00', credit: '500.00' } });
  });

  it('shows the value columns and their change for a comparison', () => {
    const { rows, debitCredit } = trialBalanceRows(trial([current, prior]), { total: 'Totals' });
    expect(debitCredit).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows[0].values).toEqual({ current: '500.00', prior: '300.00' });
    expect(rows[0].delta?.amount).toBe('200.00');
  });
});

describe('columnHeading', () => {
  const labels = { total: 'Total', quarter: 'Q{n} {year}', period: 'P{n} {year}' };
  const format = {
    formatDate: (value: string) => `d(${value})`,
    formatMonth: (value: string) => `m(${value})`,
  };

  it('names month, quarter, period and total columns', () => {
    expect(columnHeading({ key: '2026-03', label: '', from: '2026-03-01', to: '2026-03-31' }, labels, format)).toBe('m(2026-03-01)');
    expect(columnHeading({ key: '2026-Q2', label: '', from: '2026-04-01', to: '2026-06-30' }, labels, format)).toBe('Q2 2026');
    expect(columnHeading({ key: '2026-P03', label: '', from: '2026-02-01', to: '2026-03-07' }, labels, format)).toBe('P3 2026');
    expect(columnHeading({ key: 'total', label: '', from: '2026-01-01', to: '2026-12-31' }, labels, format)).toBe('Total');
  });

  it('shows the date range of a current or prior column and the single date of a point in time', () => {
    expect(columnHeading(current, labels, format)).toBe('d(2026-01-01) – d(2026-12-31)');
    expect(columnHeading({ key: 'current', label: '', from: null, to: '2026-12-31' }, labels, format)).toBe('d(2026-12-31)');
  });
});

describe('report params', () => {
  it('sends only what was set', () => {
    expect(toReportQuery(EMPTY_REPORT_PARAMS)).toEqual({});
    expect(toReportQuery({ ...EMPTY_REPORT_PARAMS, basis: 'cash', compare: 'prior_year', classId: 'dim_1' })).toEqual({
      basis: 'cash',
      compare: 'prior_year',
      classId: 'dim_1',
    });
  });

  it('lets a comparison and a month split exclude each other', () => {
    const months = applyParamsPatch(EMPTY_REPORT_PARAMS, { periods: 'months' });
    expect(months.periods).toBe('months');
    const compared = applyParamsPatch(months, { compare: 'prior_period' });
    expect(compared).toMatchObject({ compare: 'prior_period', periods: '' });
    const split = applyParamsPatch(compared, { periods: 'quarters' });
    expect(split).toMatchObject({ compare: '', periods: 'quarters' });
    // Clearing one doesn't touch the other.
    expect(applyParamsPatch(split, { compare: '' }).periods).toBe('quarters');
  });

  it('recognises the two-column layout of a comparison', () => {
    expect(isComparing([current, prior])).toBe(true);
    expect(isComparing([current])).toBe(false);
    expect(isComparing([current, { ...prior, key: 'total' }])).toBe(false);
  });
});

describe('aged buckets', () => {
  it('reads a bucket answered as a plain total or as total and count', () => {
    expect(bucketTotal('12.00')).toBe('12.00');
    expect(bucketTotal({ total: '15.00', count: 2 })).toBe('15.00');
    expect(bucketTotal(undefined)).toBe('0.00');
    expect(bucketCount({ total: '15.00', count: 2 }, undefined, 'current')).toBe(2);
    expect(bucketCount('12.00', { current: 4 }, 'current')).toBe(4);
    expect(bucketCount('12.00', undefined, 'current')).toBeNull();
  });
});
