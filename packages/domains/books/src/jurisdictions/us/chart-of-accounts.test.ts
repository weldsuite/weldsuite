import { describe, it, expect } from 'vitest';
import {
  US_REQUIRED_SYSTEM_ROLES,
  US_SOLE_PROPRIETOR_ROLES,
  getUsChartOfAccountsTemplate,
  getUsEntitySection,
  getUsEquitySection,
  usBaseChartOfAccounts,
} from './chart-of-accounts';
import { US_ENTITY_TYPES, equityModelFor, taxFormForEntity, type UsEquityModel } from './entity-types';
import { TAX_LINE_CATEGORIES, TAX_RETURN_FORMS, resolveTaxLine } from './tax-lines';

const MODELS: UsEquityModel[] = ['sole_proprietor', 'partnership', 's_corp', 'c_corp', 'nonprofit'];

/** One option set per equity model, through entity type and classification the way entities are created. */
const VARIANTS: Array<{ name: string; opts: { entityType?: string; taxClassification?: string } }> = [
  { name: 'sole proprietorship', opts: { entityType: 'sole_proprietorship' } },
  { name: 'LLC (disregarded)', opts: { entityType: 'single_member_llc', taxClassification: 'disregarded' } },
  { name: 'LLC (partnership)', opts: { entityType: 'multi_member_llc', taxClassification: 'partnership' } },
  { name: 'partnership', opts: { entityType: 'partnership' } },
  { name: 'S corp', opts: { entityType: 's_corp' } },
  { name: 'LLC (S corp election)', opts: { entityType: 'single_member_llc', taxClassification: 's_corp' } },
  { name: 'C corp', opts: { entityType: 'c_corp' } },
  { name: 'nonprofit', opts: { entityType: 'nonprofit' } },
  { name: 'no entity type', opts: {} },
];

describe.each(VARIANTS)('US chart: $name', ({ opts }) => {
  const chart = getUsChartOfAccountsTemplate(opts);
  const model = equityModelFor(opts.entityType, opts.taxClassification);

  it('has unique account codes and names', () => {
    const codes = chart.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const names = chart.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const account of chart) {
      expect(account.code).toMatch(/^\d{4}$/);
      // accounts.code is varchar(20), accounts.name varchar(255)
      expect(account.name.length).toBeLessThan(255);
    }
  });

  it('provides every system role the ledger looks up, exactly once', () => {
    const roles = chart.map((a) => a.systemRole).filter(Boolean);
    for (const role of US_REQUIRED_SYSTEM_ROLES) {
      expect(roles.filter((r) => r === role), role).toHaveLength(1);
    }
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('flags role accounts as system accounts', () => {
    for (const account of chart) {
      if (account.systemRole) expect(account.isSystemAccount, account.code).toBe(true);
    }
  });

  it('puts owner equity and draws only on the sole proprietor chart', () => {
    const roles = chart.map((a) => a.systemRole);
    for (const role of US_SOLE_PROPRIETOR_ROLES) {
      expect(roles.includes(role), role).toBe(model === 'sole_proprietor');
    }
  });

  it('references only parents that exist and lists them first', () => {
    const index = new Map(chart.map((a, i) => [a.code, i]));
    for (const [i, account] of chart.entries()) {
      if (!account.parentCode) continue;
      expect(index.has(account.parentCode), `${account.code} -> ${account.parentCode}`).toBe(true);
      expect(index.get(account.parentCode)!).toBeLessThan(i);
      const parent = chart[index.get(account.parentCode)!]!;
      expect(parent.type).toBe(account.type);
    }
  });

  it('is ordered by code', () => {
    const codes = chart.map((a) => a.code);
    expect(codes).toEqual([...codes].sort());
  });

  it('uses a normal side that matches the type, except for contra accounts', () => {
    const natural = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', revenue: 'credit' } as const;
    const contra = chart.filter((a) => a.normalSide !== natural[a.type]).map((a) => a.name);
    // accumulated depreciation, sales discounts, returns, draws and distributions, treasury stock, dividends
    for (const name of contra) {
      expect(name, name).toMatch(/depreciation|discounts|Returns|draws|distributions|Treasury|Dividends/i);
    }
    const accumulated = chart.find((a) => a.systemRole === 'accumulated_depreciation');
    expect(accumulated?.normalSide).toBe('credit');
    expect(accumulated?.type).toBe('asset');
  });

  it('gives every income, cost and expense account a tax-line category that resolves on every form for 2025 and 2026', () => {
    const pnl = chart.filter((a) => a.type === 'revenue' || a.type === 'expense');
    expect(pnl.length).toBeGreaterThan(40);
    for (const account of pnl) {
      expect(account.taxLine, `${account.code} ${account.name}`).toBeTruthy();
      expect(TAX_LINE_CATEGORIES, `${account.code} ${account.taxLine}`).toContain(account.taxLine);
      for (const form of TAX_RETURN_FORMS) {
        for (const year of [2025, 2026]) {
          expect(resolveTaxLine(account.taxLine!, form, year), `${account.code} ${account.taxLine} ${form} ${year}`).toBeDefined();
        }
      }
    }
  });

  it('resolves balance sheet categories where given', () => {
    const balanceSheet = chart.filter((a) => a.type === 'asset' || a.type === 'liability' || a.type === 'equity');
    for (const account of balanceSheet) {
      if (!account.taxLine) continue;
      expect(TAX_LINE_CATEGORIES, `${account.code} ${account.taxLine}`).toContain(account.taxLine);
    }
    // Every Schedule L asset and liability account carries one.
    for (const account of balanceSheet.filter((a) => a.type !== 'equity')) {
      expect(account.taxLine, `${account.code} ${account.name}`).toBeTruthy();
    }
  });

  it('puts income accounts on income lines and cost accounts on cost lines', () => {
    const form = taxFormForEntity(opts.entityType, opts.taxClassification);
    for (const account of chart.filter((a) => a.subtype === 'cost_of_goods_sold')) {
      expect(resolveTaxLine(account.taxLine!, form, 2025)?.section, account.code).toBe('cogs');
    }
    for (const account of chart.filter((a) => a.type === 'revenue' && a.normalSide === 'credit')) {
      expect(['income', 'other_income'], account.code).toContain(resolveTaxLine(account.taxLine!, form, 2025)?.section);
    }
  });
});

describe('US chart content', () => {
  it('uses US numbering', () => {
    const chart = getUsChartOfAccountsTemplate({});
    const byFirstDigit = (digit: string) => chart.filter((a) => a.code.startsWith(digit));
    for (const a of byFirstDigit('1')) expect(a.type).toBe('asset');
    for (const a of byFirstDigit('2')) expect(a.type).toBe('liability');
    for (const a of byFirstDigit('3')) expect(a.type).toBe('equity');
    for (const a of byFirstDigit('4')) expect(a.type).toBe('revenue');
    for (const a of byFirstDigit('5')) expect(a.type).toBe('expense');
    for (const a of byFirstDigit('6')) expect(a.type).toBe('expense');
    for (const a of byFirstDigit('7')) expect(a.type).toBe('expense');
    expect(chart.filter((a) => /^[89]/.test(a.code)).map((a) => a.code)).toEqual(['8000', '8100', '9000']);
  });

  it('has the accounts a US small business expects', () => {
    const names = getUsChartOfAccountsTemplate({}).map((a) => a.name);
    for (const name of [
      'Checking',
      'Savings',
      'Undeposited funds',
      'Accounts receivable',
      'Inventory',
      'Prepaid expenses',
      'Accumulated depreciation',
      'Accounts payable',
      'Credit card payable',
      'Sales tax payable',
      'Use tax payable',
      'Payroll liabilities',
      'Backup withholding payable',
      'Opening balance equity',
      'Sales revenue',
      'Shipping and handling income',
      'Sales tax vendor discount',
      'Cost of goods sold',
      'Contract labor',
      'Interest income',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('keeps sales tax payable as a postable parent with the role the posting code uses', () => {
    const chart = getUsChartOfAccountsTemplate({});
    const salesTax = chart.find((a) => a.systemRole === 'sales_tax_payable');
    expect(salesTax?.code).toBe('2200');
    expect(salesTax?.type).toBe('liability');
    expect(chart.find((a) => a.systemRole === 'use_tax_payable')?.code).toBe('2210');
    expect(chart.find((a) => a.systemRole === 'accounts_receivable')?.type).toBe('asset');
    expect(chart.find((a) => a.systemRole === 'accounts_payable')?.type).toBe('liability');
    expect(chart.find((a) => a.systemRole === 'sales_revenue')?.type).toBe('revenue');
  });

  it('puts a bank subtype account first so payments default to a bank, and one cash account for cash payments', () => {
    const chart = getUsChartOfAccountsTemplate({});
    expect(chart.find((a) => a.subtype === 'bank')?.code).toBe('1000');
    expect(chart.filter((a) => a.subtype === 'cash')).toHaveLength(1);
  });

  it('keeps penalties and interest out of the deductible lines', () => {
    const chart = getUsChartOfAccountsTemplate({});
    expect(chart.find((a) => a.systemRole === 'tax_penalties_interest')?.taxLine).toBe('penalties_nondeductible');
  });
});

describe('US chart 1099 boxes', () => {
  const chart = getUsChartOfAccountsTemplate({});
  const box = (name: string) => chart.find((a) => a.name === name)?.form1099Box;

  it('defaults contractor-type expenses to NEC box 1', () => {
    for (const name of [
      'Contract labor',
      'Commissions and fees',
      'Legal fees',
      'Accounting and tax preparation',
      'Consulting and other professional fees',
      'Subcontractors (production)',
    ]) {
      expect(box(name), name).toBe('nec_1');
    }
  });

  it('defaults rent to MISC box 1 and royalties to MISC box 2', () => {
    expect(box('Rent, buildings')).toBe('misc_1');
    expect(box('Equipment rental')).toBe('misc_1');
    expect(box('Royalties and license fees')).toBe('misc_2');
  });

  it('only uses known boxes and only on expense accounts', () => {
    for (const account of chart) {
      if (!account.form1099Box) continue;
      expect(account.type, account.code).toBe('expense');
      expect(['nec_1', 'misc_1', 'misc_2'], account.code).toContain(account.form1099Box);
    }
    // Wages, taxes, utilities and the like are never reported on a 1099.
    for (const name of ['Wages and salaries', 'Payroll taxes', 'Utilities', 'Taxes and licenses', 'Depreciation expense', 'Meals']) {
      expect(box(name), name).toBeUndefined();
    }
  });
});

describe('equity sections', () => {
  const names = (model: UsEquityModel) => getUsEntitySection(model).map((a) => a.name);

  it('has an owner capital account and draws for a sole proprietor', () => {
    const section = getUsEntitySection('sole_proprietor');
    expect(section.find((a) => a.systemRole === 'owner_equity')?.name).toBe("Owner's capital");
    const draws = section.find((a) => a.systemRole === 'owner_draws');
    expect(draws?.name).toBe("Owner's draws");
    expect(draws?.normalSide).toBe('debit');
    expect(names('sole_proprietor')).toContain('Business use of home');
  });

  it('has a capital, contribution and distribution account per partner for a partnership', () => {
    const section = getUsEntitySection('partnership');
    for (const partner of ['Partner 1', 'Partner 2']) {
      for (const suffix of ['capital', 'contributions', 'distributions']) {
        expect(names('partnership'), `${partner}, ${suffix}`).toContain(`${partner}, ${suffix}`);
      }
    }
    const distribution = section.find((a) => a.name === 'Partner 1, distributions');
    expect(distribution?.normalSide).toBe('debit');
    expect(distribution?.parentCode).toBe("3000");
    // guaranteed payments are an expense, not a draw
    const guaranteed = section.find((a) => a.name === 'Guaranteed payments to partners');
    expect(guaranteed?.type).toBe('expense');
    expect(guaranteed?.taxLine).toBe('guaranteed_payments');
  });

  it('has stock, paid-in capital, retained earnings, AAA and distributions for an S corp', () => {
    for (const name of [
      'Common stock',
      'Additional paid-in capital',
      'Retained earnings',
      'Accumulated adjustments account (AAA)',
      'Shareholder distributions',
      'Officer compensation',
    ]) {
      expect(names('s_corp'), name).toContain(name);
    }
    expect(names('s_corp')).not.toContain('Dividends declared');
  });

  it('has stock, paid-in capital, retained earnings, dividends and income tax for a C corp', () => {
    for (const name of [
      'Common stock',
      'Additional paid-in capital',
      'Treasury stock',
      'Retained earnings',
      'Dividends declared',
      'Income taxes payable',
      'Federal income tax expense',
      'Officer compensation',
    ]) {
      expect(names('c_corp'), name).toContain(name);
    }
    expect(names('c_corp')).not.toContain('Accumulated adjustments account (AAA)');
    expect(getUsEntitySection('c_corp').find((a) => a.name === 'Federal income tax expense')?.taxLine).toBe('federal_income_tax');
  });

  it('has net assets with and without donor restrictions for a nonprofit', () => {
    const section = getUsEntitySection('nonprofit');
    const without = section.find((a) => a.name === 'Net assets without donor restrictions');
    expect(without?.systemRole).toBe('retained_earnings');
    expect(names('nonprofit')).toContain('Net assets with donor restrictions');
    expect(names('nonprofit')).toContain('Contributions and donations');
    expect(names('nonprofit')).not.toContain('Retained earnings');
  });

  it('keeps each section clear of the base chart codes', () => {
    const base = new Set(usBaseChartOfAccounts.map((a) => a.code));
    for (const model of MODELS) {
      for (const account of getUsEntitySection(model)) {
        expect(base.has(account.code), `${model} ${account.code}`).toBe(false);
      }
    }
  });

  it('returns only equity accounts from getUsEquitySection', () => {
    for (const model of MODELS) {
      const equity = getUsEquitySection(model);
      expect(equity.length).toBeGreaterThan(0);
      expect(equity.every((a) => a.type === 'equity')).toBe(true);
    }
  });

  it('follows the tax classification for an LLC', () => {
    const llcAsSCorp = getUsChartOfAccountsTemplate({ entityType: 'single_member_llc', taxClassification: 's_corp' });
    expect(llcAsSCorp.map((a) => a.name)).toContain('Accumulated adjustments account (AAA)');
    const llcDisregarded = getUsChartOfAccountsTemplate({ entityType: 'single_member_llc' });
    expect(llcDisregarded.map((a) => a.name)).toContain("Owner's draws");
    const multi = getUsChartOfAccountsTemplate({ entityType: 'multi_member_llc' });
    expect(multi.map((a) => a.name)).toContain('Partner 1, capital');
  });

  it('covers every entity type', () => {
    for (const entityType of US_ENTITY_TYPES) {
      const chart = getUsChartOfAccountsTemplate({ entityType });
      expect(chart.length).toBeGreaterThan(usBaseChartOfAccounts.length);
    }
  });
});

describe('template hygiene', () => {
  it('returns fresh copies so a caller cannot change the template', () => {
    const first = getUsChartOfAccountsTemplate({ entityType: 's_corp' });
    first[0]!.name = 'mutated';
    first.pop();
    const second = getUsChartOfAccountsTemplate({ entityType: 's_corp' });
    expect(second[0]!.name).not.toBe('mutated');
    expect(second.length).toBe(first.length + 1);
    getUsEntitySection('s_corp')[0]!.name = 'mutated';
    expect(getUsEntitySection('s_corp')[0]!.name).not.toBe('mutated');
  });
});
