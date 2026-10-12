import { describe, expect, it } from 'vitest';
import { getAdapter } from '@weldsuite/books-domain/jurisdictions/registry';

import { profitLossSection } from './accounting-reports';
import { classifyCounterpart, activityOf } from './accounting-cash-flow';

const nlChartOfAccounts = getAdapter('NL').getChartOfAccountsTemplate();
const inChartOfAccounts = getAdapter('IN').getChartOfAccountsTemplate();
const usChartOfAccounts = getAdapter('US').getChartOfAccountsTemplate();

const section = (row: { type: string; subtype?: string | null }) => profitLossSection({ type: row.type as never, subtype: row.subtype ?? null });

describe('profit & loss sections of the seeded charts', () => {
  it('NL: operating revenue is income, only 8100-8400 sit below the operating line', () => {
    const byCode = (code: string) => nlChartOfAccounts.find((a) => a.code === code)!;
    for (const code of ['8000', '8010', '8020', '8030', '8500']) expect(section(byCode(code)), code).toBe('income');
    for (const code of ['8100', '8200', '8300', '8400']) expect(section(byCode(code)), code).toBe('other_income');
  });

  it('NL: purchases are cost of goods sold, not operating expense', () => {
    for (const code of ['4000', '4010']) {
      expect(section(nlChartOfAccounts.find((a) => a.code === code)!), code).toBe('cost_of_goods_sold');
    }
    expect(section(nlChartOfAccounts.find((a) => a.code === '4310')!)).toBe('expense');
    expect(section(nlChartOfAccounts.find((a) => a.code === '4810')!)).toBe('other_expense');
  });

  it('IN: sales are income and purchases cost of goods sold', () => {
    const byCode = (code: string) => inChartOfAccounts.find((a) => a.code === code)!;
    for (const code of ['8000', '8010', '8020', '8500']) expect(section(byCode(code)), code).toBe('income');
    for (const code of ['8100', '8400']) expect(section(byCode(code)), code).toBe('other_income');
    for (const code of ['4000', '4010']) expect(section(byCode(code)), code).toBe('cost_of_goods_sold');
  });

  it('US: unchanged', () => {
    const byCode = (code: string) => usChartOfAccounts.find((a) => a.code === code)!;
    expect(section(byCode('4000'))).toBe('income');
    expect(section(byCode('4020'))).toBe('income');
    expect(section(byCode('4100'))).toBe('other_income');
    expect(section(byCode('5000'))).toBe('cost_of_goods_sold');
  });

  it('accepts the legacy cost_of_goods subtype of entities seeded before the fix', () => {
    expect(profitLossSection({ type: 'expense', subtype: 'cost_of_goods' })).toBe('cost_of_goods_sold');
    expect(profitLossSection({ type: 'expense', subtype: 'cost_of_sales' })).toBe('cost_of_goods_sold');
    expect(profitLossSection({ type: 'expense', subtype: 'cogs' })).toBe('cost_of_goods_sold');
  });

  it('every revenue account of a chart is operating or explicitly other income', () => {
    for (const chart of [nlChartOfAccounts, inChartOfAccounts]) {
      for (const account of chart.filter((a) => a.type === 'revenue')) {
        const code = account.code;
        const expected = ['8100', '8200', '8300', '8400'].includes(code) ? 'other_income' : 'income';
        expect(section(account), code).toBe(expected);
      }
    }
  });
});

describe('cash flow counterpart classification', () => {
  const account = (type: string, subtype: string | null, name = 'Account', systemRole: string | null = null) => ({ type, subtype, name, systemRole });

  it('groups customer receipts, supplier payments and direct expenses', () => {
    expect(classifyCounterpart(account('asset', 'accounts_receivable', 'Debiteuren', 'accounts_receivable'))).toBe('customer_receipts');
    expect(classifyCounterpart(account('revenue', 'sales'))).toBe('customer_receipts');
    expect(classifyCounterpart(account('asset', 'current_asset', 'Undeposited funds', 'undeposited_funds'))).toBe('customer_receipts');
    expect(classifyCounterpart(account('liability', 'accounts_payable', 'Crediteuren', 'accounts_payable'))).toBe('supplier_payments');
    expect(classifyCounterpart(account('expense', 'operating_expense', 'Bankkosten'))).toBe('operating_expenses');
  });

  it('groups taxes, payroll, investing and financing', () => {
    expect(classifyCounterpart(account('liability', 'tax', 'BTW te betalen', 'tax_payable'))).toBe('taxes');
    expect(classifyCounterpart(account('asset', 'tax', 'BTW te vorderen'))).toBe('taxes');
    expect(classifyCounterpart(account('liability', 'tax_payable', 'Sales tax payable'))).toBe('taxes');
    expect(classifyCounterpart(account('liability', 'tax', 'Loonheffing te betalen', 'payroll_liabilities'))).toBe('payroll');
    expect(classifyCounterpart(account('asset', 'fixed_assets', 'Materiële vaste activa'))).toBe('fixed_assets');
    expect(classifyCounterpart(account('equity', 'capital', 'Privé'))).toBe('equity');
    expect(classifyCounterpart(account('liability', 'long_term_liability', 'Loans payable'))).toBe('loans');
    expect(classifyCounterpart(account('liability', 'accounts_payable', 'Langlopende leningen'))).toBe('loans');
    expect(classifyCounterpart(account('revenue', 'interest_income', 'Interest'))).toBe('other_operating');
    expect(classifyCounterpart(account('asset', 'current_asset', 'Other current assets'))).toBe('other_operating');
  });

  it('maps categories to the three activities', () => {
    expect(activityOf('customer_receipts')).toBe('operating');
    expect(activityOf('fixed_assets')).toBe('investing');
    expect(activityOf('equity')).toBe('financing');
    expect(activityOf('loans')).toBe('financing');
  });
});
