/**
 * US chart of accounts seeded when a US entity is created.
 *
 * One base chart in US numbering (1000 assets, 2000 liabilities, 3000 equity,
 * 4000 income, 5000 cost of goods sold, 6000-7000 expenses, 8000-9000 other)
 * plus a section per entity type: the equity accounts, and the few accounts
 * only that kind of entity has (officer pay for corporations, guaranteed
 * payments for partnerships, the home office for a sole proprietor, federal
 * income tax for a C corporation, contributions for a nonprofit).
 *
 * Every income, cost and expense account carries a tax-line category
 * (`taxLine`, see tax-lines.ts) that is resolved to a line of the entity's
 * return at creation, and expense accounts that usually hold payments to
 * contractors carry a 1099 box. Balance sheet accounts carry the Schedule L
 * category where one exists.
 *
 * System roles the ledger code looks accounts up by are listed in
 * `US_REQUIRED_SYSTEM_ROLES`; each exists exactly once in every variant.
 * Rows come ordered by code, parents before their children.
 */

import type {
  ChartOfAccountsTemplateOptions,
  ChartOfAccountsTemplateRow,
  SystemAccountRole,
} from '../types';
import { equityModelFor, type UsEquityModel } from './entity-types';

type Row = ChartOfAccountsTemplateRow;
type AccountType = Row['type'];

const NORMAL_SIDE: Record<AccountType, Row['normalSide']> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

/** Builds a row; the normal side follows the type unless `extra` overrides it (contra accounts, draws). */
function row(
  code: string,
  name: string,
  type: AccountType,
  subtype: string,
  extra: Partial<Omit<Row, 'code' | 'name' | 'type' | 'subtype'>> = {},
): Row {
  const { systemRole, isSystemAccount, ...rest } = extra;
  return {
    code,
    name,
    type,
    subtype,
    normalSide: NORMAL_SIDE[type],
    ...(systemRole ? { systemRole, isSystemAccount: isSystemAccount ?? true } : {}),
    ...(!systemRole && isSystemAccount ? { isSystemAccount } : {}),
    ...rest,
  };
}

/** System roles every US chart variant provides exactly once. */
export const US_REQUIRED_SYSTEM_ROLES: readonly SystemAccountRole[] = [
  'accounts_receivable',
  'accounts_payable',
  'sales_revenue',
  'general_expense',
  'bad_debt_expense',
  'retained_earnings',
  'realized_fx_gain',
  'realized_fx_loss',
  'rounding',
  'undeposited_funds',
  'sales_tax_payable',
  'use_tax_payable',
  'opening_balance_equity',
  'credit_card_payable',
  'backup_withholding_payable',
  'sales_tax_vendor_discount',
  'tax_penalties_interest',
  'accumulated_depreciation',
  'depreciation_expense',
  'fixed_assets',
  'gain_loss_on_disposal',
  'payroll_wages_expense',
  'payroll_tax_expense',
  'payroll_liabilities',
  'unapplied_cash_payment_income',
  'unapplied_cash_bill_payment_expense',
];

/** Roles only the sole proprietor chart has (an owner's capital and draws account). */
export const US_SOLE_PROPRIETOR_ROLES: readonly SystemAccountRole[] = ['owner_equity', 'owner_draws'];

export const usBaseChartOfAccounts: Row[] = [
  // ---- 1000 Assets --------------------------------------------------------
  row('1000', 'Checking', 'asset', 'bank', { taxLine: 'bs_cash' }),
  row('1010', 'Savings', 'asset', 'bank', { taxLine: 'bs_cash' }),
  row('1020', 'Petty cash', 'asset', 'cash', { taxLine: 'bs_cash' }),
  row('1050', 'Undeposited funds', 'asset', 'current_asset', { systemRole: 'undeposited_funds', taxLine: 'bs_cash' }),
  row('1100', 'Accounts receivable', 'asset', 'accounts_receivable', {
    systemRole: 'accounts_receivable',
    taxLine: 'bs_receivables',
  }),
  row('1200', 'Inventory', 'asset', 'inventory', { taxLine: 'bs_inventory' }),
  row('1300', 'Prepaid expenses', 'asset', 'prepaid_expense', { taxLine: 'bs_other_current_assets' }),
  row('1350', 'Other current assets', 'asset', 'current_asset', { taxLine: 'bs_other_current_assets' }),
  row('1500', 'Fixed assets', 'asset', 'fixed_asset', { systemRole: 'fixed_assets', taxLine: 'bs_fixed_assets' }),
  row('1510', 'Land', 'asset', 'fixed_asset', { parentCode: '1500', taxLine: 'bs_land' }),
  row('1520', 'Buildings', 'asset', 'fixed_asset', { parentCode: '1500', taxLine: 'bs_fixed_assets' }),
  row('1530', 'Machinery and equipment', 'asset', 'fixed_asset', { parentCode: '1500', taxLine: 'bs_fixed_assets' }),
  row('1540', 'Furniture and fixtures', 'asset', 'fixed_asset', { parentCode: '1500', taxLine: 'bs_fixed_assets' }),
  row('1550', 'Vehicles', 'asset', 'fixed_asset', { parentCode: '1500', taxLine: 'bs_fixed_assets' }),
  row('1560', 'Computer equipment and software', 'asset', 'fixed_asset', {
    parentCode: '1500',
    taxLine: 'bs_fixed_assets',
  }),
  row('1590', 'Accumulated depreciation', 'asset', 'fixed_asset', {
    systemRole: 'accumulated_depreciation',
    normalSide: 'credit',
    parentCode: '1500',
    taxLine: 'bs_accumulated_depreciation',
  }),
  row('1700', 'Security deposits and other assets', 'asset', 'other_asset', { taxLine: 'balance_sheet' }),

  // ---- 2000 Liabilities ---------------------------------------------------
  row('2000', 'Accounts payable', 'liability', 'accounts_payable', {
    systemRole: 'accounts_payable',
    taxLine: 'bs_payables',
  }),
  row('2100', 'Credit card payable', 'liability', 'credit_card', {
    systemRole: 'credit_card_payable',
    taxLine: 'bs_other_current_liabilities',
  }),
  // The parent of the per-agency children created when a state agency is added.
  row('2200', 'Sales tax payable', 'liability', 'tax_payable', {
    systemRole: 'sales_tax_payable',
    taxLine: 'bs_other_current_liabilities',
  }),
  row('2210', 'Use tax payable', 'liability', 'tax_payable', {
    systemRole: 'use_tax_payable',
    taxLine: 'bs_other_current_liabilities',
  }),
  row('2300', 'Payroll liabilities', 'liability', 'current_liability', {
    systemRole: 'payroll_liabilities',
    taxLine: 'bs_other_current_liabilities',
  }),
  // 24% withheld from payees without a TIN; reported on Form 945.
  row('2310', 'Backup withholding payable', 'liability', 'current_liability', {
    systemRole: 'backup_withholding_payable',
    taxLine: 'bs_other_current_liabilities',
  }),
  row('2400', 'Accrued expenses', 'liability', 'current_liability', { taxLine: 'bs_other_current_liabilities' }),
  row('2450', 'Deferred revenue and customer deposits', 'liability', 'current_liability', {
    taxLine: 'bs_other_current_liabilities',
  }),
  row('2500', 'Line of credit', 'liability', 'current_liability', { taxLine: 'bs_other_current_liabilities' }),
  row('2600', 'Loans payable', 'liability', 'long_term_liability', { taxLine: 'bs_long_term_debt' }),

  // ---- 3000 Equity (the rest is per entity type) --------------------------
  row('3900', 'Opening balance equity', 'equity', 'owners_equity', {
    systemRole: 'opening_balance_equity',
    taxLine: 'bs_retained_earnings',
  }),

  // ---- 4000 Income --------------------------------------------------------
  row('4000', 'Sales revenue', 'revenue', 'sales', { systemRole: 'sales_revenue', taxLine: 'gross_receipts' }),
  row('4010', 'Product sales', 'revenue', 'sales', { taxLine: 'gross_receipts' }),
  row('4020', 'Service revenue', 'revenue', 'service_revenue', { taxLine: 'gross_receipts' }),
  row('4030', 'Shipping and handling income', 'revenue', 'sales', { taxLine: 'gross_receipts' }),
  row('4040', 'Sales discounts', 'revenue', 'sales', { normalSide: 'debit', taxLine: 'returns_allowances' }),
  row('4050', 'Returns and allowances', 'revenue', 'sales', { normalSide: 'debit', taxLine: 'returns_allowances' }),
  row('4100', 'Other income', 'revenue', 'other_income', { taxLine: 'other_income' }),
  // What a state lets the seller keep for filing and paying on time.
  row('4110', 'Sales tax vendor discount', 'revenue', 'other_income', {
    systemRole: 'sales_tax_vendor_discount',
    taxLine: 'other_income',
  }),
  row('4120', 'Unapplied cash payment income', 'revenue', 'other_income', {
    systemRole: 'unapplied_cash_payment_income',
    taxLine: 'other_income',
  }),
  row('4130', 'Realized foreign exchange gain', 'revenue', 'other_income', {
    systemRole: 'realized_fx_gain',
    taxLine: 'other_income',
  }),

  // ---- 5000 Cost of goods sold -------------------------------------------
  row('5000', 'Cost of goods sold', 'expense', 'cost_of_goods_sold', { taxLine: 'cogs_purchases' }),
  row('5010', 'Materials and supplies (production)', 'expense', 'cost_of_goods_sold', { taxLine: 'cogs_materials' }),
  row('5020', 'Direct labor', 'expense', 'cost_of_goods_sold', { taxLine: 'cogs_labor' }),
  row('5030', 'Subcontractors (production)', 'expense', 'cost_of_goods_sold', {
    taxLine: 'cogs_labor',
    form1099Box: 'nec_1',
  }),
  row('5040', 'Freight-in and delivery', 'expense', 'cost_of_goods_sold', { taxLine: 'cogs_other' }),
  row('5050', 'Inventory adjustments and shrinkage', 'expense', 'cost_of_goods_sold', { taxLine: 'cogs_other' }),

  // ---- 6000 Operating expenses -------------------------------------------
  row('6000', 'Advertising and marketing', 'expense', 'operating_expense', { taxLine: 'advertising' }),
  row('6010', 'Car and truck expenses', 'expense', 'operating_expense', { taxLine: 'car_truck' }),
  row('6020', 'Commissions and fees', 'expense', 'operating_expense', {
    taxLine: 'commissions_fees',
    form1099Box: 'nec_1',
  }),
  row('6030', 'Contract labor', 'expense', 'operating_expense', { taxLine: 'contract_labor', form1099Box: 'nec_1' }),
  row('6040', 'Depreciation expense', 'expense', 'depreciation', {
    systemRole: 'depreciation_expense',
    taxLine: 'depreciation',
  }),
  row('6045', 'Amortization expense', 'expense', 'depreciation', { taxLine: 'amortization' }),
  row('6050', 'Dues and subscriptions', 'expense', 'operating_expense', { taxLine: 'other_expenses' }),
  row('6055', 'Education and training', 'expense', 'operating_expense', { taxLine: 'other_expenses' }),
  row('6060', 'Employee benefit programs', 'expense', 'operating_expense', { taxLine: 'employee_benefits' }),
  row('6070', 'Equipment rental', 'expense', 'operating_expense', {
    taxLine: 'rent_vehicles_equipment',
    form1099Box: 'misc_1',
  }),
  row('6080', 'Insurance', 'expense', 'operating_expense', { taxLine: 'insurance' }),
  row('6090', 'Legal fees', 'expense', 'operating_expense', { taxLine: 'legal_professional', form1099Box: 'nec_1' }),
  row('6095', 'Accounting and tax preparation', 'expense', 'operating_expense', {
    taxLine: 'legal_professional',
    form1099Box: 'nec_1',
  }),
  row('6100', 'Consulting and other professional fees', 'expense', 'operating_expense', {
    taxLine: 'legal_professional',
    form1099Box: 'nec_1',
  }),
  row('6110', 'Office expenses', 'expense', 'operating_expense', { taxLine: 'office_expense' }),
  row('6115', 'Software and subscriptions', 'expense', 'operating_expense', { taxLine: 'office_expense' }),
  row('6120', 'Postage and delivery', 'expense', 'operating_expense', { taxLine: 'office_expense' }),
  row('6125', 'Royalties and license fees', 'expense', 'operating_expense', {
    taxLine: 'royalties',
    form1099Box: 'misc_2',
  }),
  row('6130', 'Pension and profit-sharing plans', 'expense', 'operating_expense', { taxLine: 'pension' }),
  row('6140', 'Rent, buildings', 'expense', 'operating_expense', { taxLine: 'rent_other', form1099Box: 'misc_1' }),
  row('6150', 'Repairs and maintenance', 'expense', 'operating_expense', { taxLine: 'repairs' }),
  row('6160', 'Supplies', 'expense', 'operating_expense', { taxLine: 'supplies' }),
  row('6170', 'Taxes and licenses', 'expense', 'operating_expense', { taxLine: 'taxes_licenses' }),
  row('6175', 'Payroll taxes', 'expense', 'payroll', { systemRole: 'payroll_tax_expense', taxLine: 'payroll_taxes' }),
  row('6180', 'Travel', 'expense', 'operating_expense', { taxLine: 'travel' }),
  // Booked in full; the return allows 50% (tax-lines.ts getDeductiblePercent).
  row('6185', 'Meals', 'expense', 'operating_expense', { taxLine: 'meals' }),
  row('6190', 'Telephone and internet', 'expense', 'operating_expense', { taxLine: 'utilities' }),
  row('6195', 'Utilities', 'expense', 'operating_expense', { taxLine: 'utilities' }),
  row('6200', 'Wages and salaries', 'expense', 'payroll', { systemRole: 'payroll_wages_expense', taxLine: 'wages' }),
  row('6210', 'Bad debt expense', 'expense', 'operating_expense', {
    systemRole: 'bad_debt_expense',
    taxLine: 'bad_debts',
  }),
  row('6220', 'Charitable contributions', 'expense', 'operating_expense', { taxLine: 'charitable' }),
  row('6290', 'General and miscellaneous expense', 'expense', 'operating_expense', {
    systemRole: 'general_expense',
    taxLine: 'other_expenses',
  }),

  // ---- 7000 Financial and other expenses ---------------------------------
  row('7000', 'Interest expense, mortgage', 'expense', 'interest_expense', { taxLine: 'interest_mortgage' }),
  row('7010', 'Interest expense, other', 'expense', 'interest_expense', { taxLine: 'interest_other' }),
  row('7020', 'Bank service charges', 'expense', 'operating_expense', { taxLine: 'other_expenses' }),
  row('7030', 'Merchant and payment processing fees', 'expense', 'operating_expense', { taxLine: 'commissions_fees' }),
  // Late-filing penalties and interest on tax; penalties are never deductible.
  row('7040', 'Tax penalties and interest', 'expense', 'other_expense', {
    systemRole: 'tax_penalties_interest',
    taxLine: 'penalties_nondeductible',
  }),
  row('7050', 'Fines and other penalties', 'expense', 'other_expense', { taxLine: 'penalties_nondeductible' }),
  row('7100', 'Realized foreign exchange loss', 'expense', 'other_expense', {
    systemRole: 'realized_fx_loss',
    taxLine: 'other_expenses',
  }),
  row('7110', 'Rounding differences', 'expense', 'other_expense', { systemRole: 'rounding', taxLine: 'other_expenses' }),
  row('7120', 'Unapplied cash bill payment expense', 'expense', 'other_expense', {
    systemRole: 'unapplied_cash_bill_payment_expense',
    taxLine: 'other_expenses',
  }),

  // ---- 8000-9000 Other income and expense --------------------------------
  row('8000', 'Interest income', 'revenue', 'interest_income', { taxLine: 'interest_income' }),
  // One account for both: a gain is a credit, a loss a debit.
  row('8100', 'Gain or loss on disposal of assets', 'revenue', 'other_income', {
    systemRole: 'gain_loss_on_disposal',
    taxLine: 'gain_loss_on_disposal',
  }),
  row('9000', 'Other non-operating expense', 'expense', 'other_expense', { taxLine: 'other_expenses' }),
];

// ---------------------------------------------------------------------------
// Entity sections
// ---------------------------------------------------------------------------

const RETAINED_EARNINGS_CODE = '3200';

const soleProprietorSection: Row[] = [
  row('3000', "Owner's capital", 'equity', 'owners_equity', { systemRole: 'owner_equity', taxLine: 'bs_capital' }),
  row('3010', "Owner's investment", 'equity', 'owners_equity', { taxLine: 'bs_capital' }),
  row('3100', "Owner's draws", 'equity', 'owners_equity', {
    systemRole: 'owner_draws',
    normalSide: 'debit',
    taxLine: 'bs_distributions',
  }),
  row(RETAINED_EARNINGS_CODE, 'Retained earnings', 'equity', 'retained_earnings', {
    systemRole: 'retained_earnings',
    taxLine: 'bs_retained_earnings',
  }),
  row('6230', 'Business use of home', 'expense', 'operating_expense', { taxLine: 'home_office' }),
];

/** Two partners to start with; the setup flow adds an account trio per further partner. */
function partnerAccounts(n: 1 | 2): Row[] {
  const base = n === 1 ? 3010 : 3110;
  const label = `Partner ${n}`;
  return [
    row(String(base), `${label}, capital`, 'equity', 'owners_equity', { parentCode: '3000', taxLine: 'bs_capital' }),
    row(String(base + 10), `${label}, contributions`, 'equity', 'owners_equity', {
      parentCode: '3000',
      taxLine: 'bs_capital',
    }),
    row(String(base + 20), `${label}, distributions`, 'equity', 'owners_equity', {
      parentCode: '3000',
      normalSide: 'debit',
      taxLine: 'bs_distributions',
    }),
  ];
}

const partnershipSection: Row[] = [
  row('3000', "Partners' capital", 'equity', 'owners_equity', { taxLine: 'bs_capital' }),
  ...partnerAccounts(1),
  ...partnerAccounts(2),
  // Profit not yet allocated to the partners' capital accounts.
  row(RETAINED_EARNINGS_CODE, 'Retained earnings', 'equity', 'retained_earnings', {
    systemRole: 'retained_earnings',
    taxLine: 'bs_retained_earnings',
  }),
  // Pay for services, deducted before partnership income (1065 line 10); not a draw.
  row('6202', 'Guaranteed payments to partners', 'expense', 'payroll', { taxLine: 'guaranteed_payments' }),
];

const officerCompensation: Row = row('6201', 'Officer compensation', 'expense', 'payroll', {
  taxLine: 'officer_compensation',
});

const sCorpSection: Row[] = [
  row('3000', 'Common stock', 'equity', 'share_capital', { taxLine: 'bs_capital' }),
  row('3010', 'Additional paid-in capital', 'equity', 'share_capital', { taxLine: 'bs_apic' }),
  row(RETAINED_EARNINGS_CODE, 'Retained earnings', 'equity', 'retained_earnings', {
    systemRole: 'retained_earnings',
    taxLine: 'bs_retained_earnings',
  }),
  // Tracked for Schedule M-2; the accountant moves income and distributions through it at year end.
  row('3210', 'Accumulated adjustments account (AAA)', 'equity', 'retained_earnings', {
    taxLine: 'bs_retained_earnings',
  }),
  row('3300', 'Shareholder distributions', 'equity', 'owners_equity', {
    normalSide: 'debit',
    taxLine: 'bs_distributions',
  }),
  officerCompensation,
];

const cCorpSection: Row[] = [
  row('3000', 'Common stock', 'equity', 'share_capital', { taxLine: 'bs_capital' }),
  row('3010', 'Additional paid-in capital', 'equity', 'share_capital', { taxLine: 'bs_apic' }),
  row('3100', 'Treasury stock', 'equity', 'share_capital', { normalSide: 'debit', taxLine: 'bs_capital' }),
  row(RETAINED_EARNINGS_CODE, 'Retained earnings', 'equity', 'retained_earnings', {
    systemRole: 'retained_earnings',
    taxLine: 'bs_retained_earnings',
  }),
  row('3300', 'Dividends declared', 'equity', 'retained_earnings', {
    normalSide: 'debit',
    taxLine: 'bs_distributions',
  }),
  row('2420', 'Income taxes payable', 'liability', 'tax_payable', { taxLine: 'bs_other_current_liabilities' }),
  officerCompensation,
  row('9100', 'Federal income tax expense', 'expense', 'tax_expense', { taxLine: 'federal_income_tax' }),
  row('9110', 'State income tax expense', 'expense', 'tax_expense', { taxLine: 'taxes_licenses' }),
];

const nonprofitSection: Row[] = [
  row(RETAINED_EARNINGS_CODE, 'Net assets without donor restrictions', 'equity', 'retained_earnings', {
    systemRole: 'retained_earnings',
    taxLine: 'bs_retained_earnings',
  }),
  row('3210', 'Net assets with donor restrictions', 'equity', 'retained_earnings', {
    taxLine: 'bs_retained_earnings',
  }),
  row('4600', 'Contributions and donations', 'revenue', 'other_income', { taxLine: 'contributions_grants' }),
  row('4610', 'Contributions with donor restrictions', 'revenue', 'other_income', { taxLine: 'contributions_grants' }),
  row('4620', 'Grants', 'revenue', 'other_income', { taxLine: 'contributions_grants' }),
  row('4630', 'Membership dues', 'revenue', 'other_income', { taxLine: 'membership_dues' }),
  officerCompensation,
];

const ENTITY_SECTIONS: Record<UsEquityModel, Row[]> = {
  sole_proprietor: soleProprietorSection,
  partnership: partnershipSection,
  s_corp: sCorpSection,
  c_corp: cCorpSection,
  nonprofit: nonprofitSection,
};

/** The accounts specific to an entity's tax classification: its equity section and entity-only accounts. */
export function getUsEntitySection(model: UsEquityModel): Row[] {
  return ENTITY_SECTIONS[model].map((r) => ({ ...r }));
}

/** The equity accounts of an entity's section. */
export function getUsEquitySection(model: UsEquityModel): Row[] {
  return getUsEntitySection(model).filter((r) => r.type === 'equity');
}

/**
 * The chart a new US entity is seeded with: the base chart plus the section for
 * its entity type and tax classification (a sole proprietor's when neither is
 * known). Ordered by code, parents first.
 */
export function getUsChartOfAccountsTemplate(opts: ChartOfAccountsTemplateOptions = {}): Row[] {
  const model = equityModelFor(opts.entityType, opts.taxClassification);
  return [...usBaseChartOfAccounts, ...ENTITY_SECTIONS[model]]
    .map((r) => ({ ...r }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
