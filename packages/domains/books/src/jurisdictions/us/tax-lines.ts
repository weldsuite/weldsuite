/**
 * Income-tax return line catalogs and the default mapping from the chart of
 * accounts (docs/plans/weldbooks-us.md §1, federal.md §3).
 *
 * A chart row carries a tax-line category (`ChartOfAccountsTemplateRow.taxLine`,
 * e.g. `advertising`). Which return line that lands on depends on the entity's
 * return (Schedule C, 1065, 1120-S, 1120 or 990) and on the tax year, so the
 * category is resolved when the entity is created (`resolveTaxLine`) and the
 * result, a form-prefixed line code such as `sch_c.8`, is what
 * `accounts.tax_line` stores. The user can re-map any account to another line
 * of the same catalog.
 *
 * Codes are `<form>.<line key>`. Catalogs are versioned per tax year because
 * the IRS renumbers lines: Schedule C lines 27a and 27b swapped for 2025
 * (27a is now the energy efficient commercial buildings deduction and 27b is
 * other expenses). Layouts are modelled for tax years 2023 and later; earlier
 * years use the 2023 layout.
 *
 * Page 1 lines are listed with the lines accounts map to. Items the return
 * reports elsewhere get their own line: separately stated Schedule K items
 * (interest income, charitable contributions, nondeductible expenses),
 * Schedule M-1 for Form 1120, Schedule L balance sheet lines, and Form 1125-A
 * cost of goods sold lines. Lines no account maps to by default (depletion,
 * energy efficient buildings deduction) stay in the catalog so a preparer can
 * map to them.
 */

export type TaxReturnForm = 'sch_c' | 'f1065' | 'f1120s' | 'f1120' | 'f990';

export type TaxLineSection =
  | 'income'
  | 'cogs'
  | 'deduction'
  | 'other_income'
  | 'other_deduction'
  | 'balance_sheet'
  | 'equity'
  | 'not_deductible';

export interface TaxLineDef {
  /** `<form>.<line key>`, e.g. `sch_c.8`, `f1120s.7`, `f1065.10`. */
  code: string;
  form: TaxReturnForm;
  /** Line number as printed on the form, e.g. `24b`, `Sch K 16c`. */
  line: string;
  label: string;
  section: TaxLineSection;
}

export const TAX_RETURN_FORMS: readonly TaxReturnForm[] = ['sch_c', 'f1065', 'f1120s', 'f1120', 'f990'];

export const TAX_FORM_LABELS: Record<TaxReturnForm, string> = {
  sch_c: 'Schedule C (Form 1040)',
  f1065: 'Form 1065',
  f1120s: 'Form 1120-S',
  f1120: 'Form 1120',
  f990: 'Form 990',
};

export function isTaxReturnForm(value: unknown): value is TaxReturnForm {
  return typeof value === 'string' && (TAX_RETURN_FORMS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * The tax-line categories a chart row can carry. One key per kind of income,
 * cost or balance sheet account; `TAX_LINE_MAP` says where each lands per form.
 */
export const TAX_LINE_CATEGORY_KEYS = [
  // Income
  'gross_receipts',
  'returns_allowances',
  'other_income',
  'interest_income',
  'gain_loss_on_disposal',
  'contributions_grants',
  'membership_dues',
  // Cost of goods sold
  'cogs_beginning_inventory',
  'cogs_purchases',
  'cogs_labor',
  'cogs_materials',
  'cogs_other',
  'cogs_ending_inventory',
  // Deductions
  'advertising',
  'car_truck',
  'commissions_fees',
  'contract_labor',
  'depreciation',
  'amortization',
  'employee_benefits',
  'insurance',
  'interest_mortgage',
  'interest_other',
  'legal_professional',
  'office_expense',
  'pension',
  'rent_vehicles_equipment',
  'rent_other',
  'repairs',
  'supplies',
  'taxes_licenses',
  'payroll_taxes',
  'travel',
  'meals',
  'utilities',
  'wages',
  'officer_compensation',
  'guaranteed_payments',
  'bad_debts',
  'charitable',
  'home_office',
  'royalties',
  'other_expenses',
  // Never deductible on the return (M-1 / Schedule K nondeductible expenses)
  'penalties_nondeductible',
  'federal_income_tax',
  // Balance sheet (Schedule L) and equity roll-forward (Schedule M-2)
  'balance_sheet',
  'bs_cash',
  'bs_receivables',
  'bs_inventory',
  'bs_other_current_assets',
  'bs_land',
  'bs_fixed_assets',
  'bs_accumulated_depreciation',
  'bs_payables',
  'bs_other_current_liabilities',
  'bs_long_term_debt',
  'bs_capital',
  'bs_apic',
  'bs_retained_earnings',
  'bs_distributions',
] as const;

export type TaxLineCategory = (typeof TAX_LINE_CATEGORY_KEYS)[number];

export const TAX_LINE_CATEGORIES: readonly string[] = TAX_LINE_CATEGORY_KEYS;

export function isTaxLineCategory(value: unknown): value is TaxLineCategory {
  return typeof value === 'string' && (TAX_LINE_CATEGORIES as readonly string[]).includes(value);
}

/** Share of the book amount the return lets the business deduct (meals: 50%). */
const DEDUCTIBLE_PERCENT: Partial<Record<TaxLineCategory, number>> = {
  meals: 50,
};

/** Percent of an account's book amount that is deductible; 100 unless the category is limited. */
export function getDeductiblePercent(category: string): number {
  return isTaxLineCategory(category) ? (DEDUCTIBLE_PERCENT[category] ?? 100) : 100;
}

// ---------------------------------------------------------------------------
// Layout versions
// ---------------------------------------------------------------------------

/** First tax year the catalogs model; earlier years use this layout. */
export const TAX_LINE_FIRST_YEAR = 2023;

type Layout = 'v2023' | 'v2025';

/** Schedule C 27a/27b swapped for tax year 2025; every other catalog is stable from 2023. */
function layoutFor(form: TaxReturnForm, taxYear: number): Layout {
  return form === 'sch_c' && taxYear >= 2025 ? 'v2025' : 'v2023';
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

type Row = readonly [key: string, line: string, label: string, section: TaxLineSection];

function build(form: TaxReturnForm, rows: readonly Row[]): TaxLineDef[] {
  return rows.map(([key, line, label, section]) => ({ code: `${form}.${key}`, form, line, label, section }));
}

function schCRows(layout: Layout): Row[] {
  const energy: Row = ['27a', '27a', 'Energy efficient commercial buildings deduction (Form 7205)', 'deduction'];
  const other: Row = ['27b', '27b', 'Other expenses (from line 48)', 'other_deduction'];
  // Through 2024: 27a other expenses, 27b energy efficient buildings. 2025: swapped.
  const line27: Row[] =
    layout === 'v2025'
      ? [energy, other]
      : [
          ['27a', '27a', 'Other expenses (from line 48)', 'other_deduction'],
          ['27b', '27b', 'Energy efficient commercial buildings deduction (Form 7205)', 'deduction'],
        ];
  return [
    ['1', '1', 'Gross receipts or sales', 'income'],
    ['2', '2', 'Returns and allowances', 'income'],
    ['6', '6', 'Other income, including federal and state gasoline or fuel tax credit or refund', 'other_income'],
    ['f1040', 'Form 1040', 'Reported on Form 1040 instead (interest, dividends, gains on business property)', 'other_income'],
    ['35', 'III-35', 'Inventory at beginning of year', 'cogs'],
    ['36', 'III-36', 'Purchases less cost of items withdrawn for personal use', 'cogs'],
    ['37', 'III-37', 'Cost of labor (do not include any amounts paid to yourself)', 'cogs'],
    ['38', 'III-38', 'Materials and supplies', 'cogs'],
    ['39', 'III-39', 'Other costs', 'cogs'],
    ['41', 'III-41', 'Inventory at end of year', 'cogs'],
    ['8', '8', 'Advertising', 'deduction'],
    ['9', '9', 'Car and truck expenses', 'deduction'],
    ['10', '10', 'Commissions and fees', 'deduction'],
    ['11', '11', 'Contract labor', 'deduction'],
    ['12', '12', 'Depletion', 'deduction'],
    ['13', '13', 'Depreciation and section 179 expense deduction', 'deduction'],
    ['14', '14', 'Employee benefit programs (other than on line 19)', 'deduction'],
    ['15', '15', 'Insurance (other than health)', 'deduction'],
    ['16a', '16a', 'Interest: mortgage (paid to banks, etc.)', 'deduction'],
    ['16b', '16b', 'Interest: other', 'deduction'],
    ['17', '17', 'Legal and professional services', 'deduction'],
    ['18', '18', 'Office expense', 'deduction'],
    ['19', '19', 'Pension and profit-sharing plans', 'deduction'],
    ['20a', '20a', 'Rent or lease: vehicles, machinery, and equipment', 'deduction'],
    ['20b', '20b', 'Rent or lease: other business property', 'deduction'],
    ['21', '21', 'Repairs and maintenance', 'deduction'],
    ['22', '22', 'Supplies', 'deduction'],
    ['23', '23', 'Taxes and licenses', 'deduction'],
    ['24a', '24a', 'Travel', 'deduction'],
    ['24b', '24b', 'Deductible meals', 'deduction'],
    ['25', '25', 'Utilities', 'deduction'],
    ['26', '26', 'Wages (less employment credits)', 'deduction'],
    ...line27,
    ['30', '30', 'Expenses for business use of your home', 'deduction'],
    ['48', 'V-48', 'Total other expenses, itemized (the total flows to line 27)', 'other_deduction'],
    ['nd', 'n/a', 'Not deductible on Schedule C (owner pay, charitable gifts, penalties, income tax)', 'not_deductible'],
    ['bs', 'n/a', 'Balance sheet (Schedule C has none)', 'balance_sheet'],
  ];
}

const F1125A_ROWS: Row[] = [
  ['1125a_1', '1125-A 1', 'Inventory at beginning of year', 'cogs'],
  ['1125a_2', '1125-A 2', 'Purchases', 'cogs'],
  ['1125a_3', '1125-A 3', 'Cost of labor', 'cogs'],
  ['1125a_4', '1125-A 4', 'Additional section 263A costs', 'cogs'],
  ['1125a_5', '1125-A 5', 'Other costs', 'cogs'],
  ['1125a_7', '1125-A 7', 'Inventory at end of year', 'cogs'],
];

const F1065_ROWS: Row[] = [
  ['1a', '1a', 'Gross receipts or sales', 'income'],
  ['1b', '1b', 'Returns and allowances', 'income'],
  ...F1125A_ROWS,
  ['4', '4', 'Ordinary income (loss) from other partnerships, estates, and trusts', 'other_income'],
  ['6', '6', 'Net gain (loss) from Form 4797', 'other_income'],
  ['7', '7', 'Other income (loss)', 'other_income'],
  ['k5', 'Sch K 5', 'Interest income (separately stated, Schedule K line 5)', 'other_income'],
  ['9', '9', 'Salaries and wages (other than to partners, less employment credits)', 'deduction'],
  ['10', '10', 'Guaranteed payments to partners', 'deduction'],
  ['11', '11', 'Repairs and maintenance', 'deduction'],
  ['12', '12', 'Bad debts', 'deduction'],
  ['13', '13', 'Rent', 'deduction'],
  ['14', '14', 'Taxes and licenses', 'deduction'],
  ['15', '15', 'Interest', 'deduction'],
  ['16a', '16a', 'Depreciation (from Form 4562)', 'deduction'],
  ['17', '17', 'Depletion', 'deduction'],
  ['18', '18', 'Retirement plans, etc.', 'deduction'],
  ['19', '19', 'Employee benefit programs', 'deduction'],
  ['20', '20', 'Energy efficient commercial buildings deduction', 'deduction'],
  ['21', '21', 'Other deductions', 'other_deduction'],
  ['k13a', 'Sch K 13a', 'Charitable contributions (separately stated, Schedule K line 13a)', 'deduction'],
  ['k18c', 'Sch K 18c', 'Nondeductible expenses (Schedule K line 18c)', 'not_deductible'],
  ['l1', 'Sch L 1', 'Cash', 'balance_sheet'],
  ['l2a', 'Sch L 2a', 'Trade notes and accounts receivable', 'balance_sheet'],
  ['l3', 'Sch L 3', 'Inventories', 'balance_sheet'],
  ['l6', 'Sch L 6', 'Other current assets', 'balance_sheet'],
  ['l9a', 'Sch L 9a', 'Buildings and other depreciable assets', 'balance_sheet'],
  ['l9b', 'Sch L 9b', 'Less accumulated depreciation', 'balance_sheet'],
  ['l11', 'Sch L 11', 'Land (net of any amortization)', 'balance_sheet'],
  ['l15', 'Sch L 15', 'Accounts payable', 'balance_sheet'],
  ['l17', 'Sch L 17', 'Other current liabilities', 'balance_sheet'],
  ['l19b', 'Sch L 19b', 'Mortgages, notes, bonds payable in 1 year or more', 'balance_sheet'],
  ['l21', 'Sch L 21', "Partners' capital accounts", 'equity'],
  ['l_other', 'Sch L', 'Other balance sheet accounts (Schedule L, attach statement)', 'balance_sheet'],
  ['m2_6', 'Sch M-2 6', 'Distributions to partners', 'equity'],
];

const F1120S_ROWS: Row[] = [
  ['1a', '1a', 'Gross receipts or sales', 'income'],
  ['1b', '1b', 'Returns and allowances', 'income'],
  ...F1125A_ROWS,
  ['4', '4', 'Net gain (loss) from Form 4797', 'other_income'],
  ['5', '5', 'Other income (loss)', 'other_income'],
  ['k4', 'Sch K 4', 'Interest income (separately stated, Schedule K line 4)', 'other_income'],
  ['7', '7', 'Compensation of officers', 'deduction'],
  ['8', '8', 'Salaries and wages (less employment credits)', 'deduction'],
  ['9', '9', 'Repairs and maintenance', 'deduction'],
  ['10', '10', 'Bad debts', 'deduction'],
  ['11', '11', 'Rents', 'deduction'],
  ['12', '12', 'Taxes and licenses', 'deduction'],
  ['13', '13', 'Interest', 'deduction'],
  ['14', '14', 'Depreciation not claimed on Form 1125-A or elsewhere on return', 'deduction'],
  ['15', '15', 'Depletion', 'deduction'],
  ['16', '16', 'Advertising', 'deduction'],
  ['17', '17', 'Pension, profit-sharing, etc., plans', 'deduction'],
  ['18', '18', 'Employee benefit programs', 'deduction'],
  ['19', '19', 'Energy efficient commercial buildings deduction', 'deduction'],
  ['20', '20', 'Other deductions', 'other_deduction'],
  ['k12a', 'Sch K 12a', 'Charitable contributions (separately stated, Schedule K line 12a)', 'deduction'],
  ['k16c', 'Sch K 16c', 'Nondeductible expenses (Schedule K line 16c)', 'not_deductible'],
  ['l1', 'Sch L 1', 'Cash', 'balance_sheet'],
  ['l2a', 'Sch L 2a', 'Trade notes and accounts receivable', 'balance_sheet'],
  ['l3', 'Sch L 3', 'Inventories', 'balance_sheet'],
  ['l6', 'Sch L 6', 'Other current assets', 'balance_sheet'],
  ['l10a', 'Sch L 10a', 'Buildings and other depreciable assets', 'balance_sheet'],
  ['l10b', 'Sch L 10b', 'Less accumulated depreciation', 'balance_sheet'],
  ['l12', 'Sch L 12', 'Land (net of any amortization)', 'balance_sheet'],
  ['l16', 'Sch L 16', 'Accounts payable', 'balance_sheet'],
  ['l18', 'Sch L 18', 'Other current liabilities', 'balance_sheet'],
  ['l20', 'Sch L 20', 'Mortgages, notes, bonds payable in 1 year or more', 'balance_sheet'],
  ['l22', 'Sch L 22', 'Capital stock', 'equity'],
  ['l23', 'Sch L 23', 'Additional paid-in capital', 'equity'],
  ['l24', 'Sch L 24', 'Retained earnings', 'equity'],
  ['l_other', 'Sch L', 'Other balance sheet accounts (Schedule L, attach statement)', 'balance_sheet'],
  ['m2_7', 'Sch M-2 7', 'Distributions other than dividend distributions', 'equity'],
];

const F1120_ROWS: Row[] = [
  ['1a', '1a', 'Gross receipts or sales', 'income'],
  ['1b', '1b', 'Returns and allowances', 'income'],
  ...F1125A_ROWS,
  ['5', '5', 'Interest', 'other_income'],
  ['9', '9', 'Net gain or (loss) from Form 4797', 'other_income'],
  ['10', '10', 'Other income', 'other_income'],
  ['12', '12', 'Compensation of officers', 'deduction'],
  ['13', '13', 'Salaries and wages (less employment credits)', 'deduction'],
  ['14', '14', 'Repairs and maintenance', 'deduction'],
  ['15', '15', 'Bad debts', 'deduction'],
  ['16', '16', 'Rents', 'deduction'],
  ['17', '17', 'Taxes and licenses', 'deduction'],
  ['18', '18', 'Interest', 'deduction'],
  ['19', '19', 'Charitable contributions', 'deduction'],
  ['20', '20', 'Depreciation from Form 4562 not claimed on Form 1125-A or elsewhere on return', 'deduction'],
  ['21', '21', 'Depletion', 'deduction'],
  ['22', '22', 'Advertising', 'deduction'],
  ['23', '23', 'Pension, profit-sharing, etc., plans', 'deduction'],
  ['24', '24', 'Employee benefit programs', 'deduction'],
  ['25', '25', 'Energy efficient commercial buildings deduction', 'deduction'],
  ['26', '26', 'Other deductions', 'other_deduction'],
  ['m1_2', 'Sch M-1 2', 'Federal income tax per books', 'not_deductible'],
  ['m1_5', 'Sch M-1 5', 'Expenses recorded on books not deducted on this return (itemize, e.g. fines and penalties)', 'not_deductible'],
  ['m1_5c', 'Sch M-1 5c', 'Travel and entertainment (nondeductible part of meals)', 'not_deductible'],
  ['l1', 'Sch L 1', 'Cash', 'balance_sheet'],
  ['l2a', 'Sch L 2a', 'Trade notes and accounts receivable', 'balance_sheet'],
  ['l3', 'Sch L 3', 'Inventories', 'balance_sheet'],
  ['l6', 'Sch L 6', 'Other current assets', 'balance_sheet'],
  ['l10a', 'Sch L 10a', 'Buildings and other depreciable assets', 'balance_sheet'],
  ['l10b', 'Sch L 10b', 'Less accumulated depreciation', 'balance_sheet'],
  ['l12', 'Sch L 12', 'Land (net of any amortization)', 'balance_sheet'],
  ['l16', 'Sch L 16', 'Accounts payable', 'balance_sheet'],
  ['l18', 'Sch L 18', 'Other current liabilities', 'balance_sheet'],
  ['l20', 'Sch L 20', 'Mortgages, notes, bonds payable in 1 year or more', 'balance_sheet'],
  ['l22', 'Sch L 22', 'Capital stock', 'equity'],
  ['l23', 'Sch L 23', 'Additional paid-in capital', 'equity'],
  ['l25', 'Sch L 25', 'Retained earnings, unappropriated', 'equity'],
  ['l_other', 'Sch L', 'Other balance sheet accounts (Schedule L, attach statement)', 'balance_sheet'],
  ['m2_5', 'Sch M-2 5', 'Distributions (cash, stock, property)', 'equity'],
];

const F990_ROWS: Row[] = [
  ['viii_1b', 'VIII 1b', 'Membership dues', 'income'],
  ['viii_1f', 'VIII 1f', 'All other contributions, gifts, grants, and similar amounts', 'income'],
  ['viii_2', 'VIII 2', 'Program service revenue', 'income'],
  ['viii_3', 'VIII 3', 'Investment income', 'other_income'],
  ['viii_7', 'VIII 7', 'Sale of assets other than inventory', 'other_income'],
  ['viii_10b', 'VIII 10b', 'Less: cost of goods sold', 'cogs'],
  ['viii_11', 'VIII 11', 'Miscellaneous revenue', 'other_income'],
  ['ix_1', 'IX 1', 'Grants and other assistance to domestic organizations and governments', 'deduction'],
  ['ix_5', 'IX 5', 'Compensation of current officers, directors, trustees, and key employees', 'deduction'],
  ['ix_7', 'IX 7', 'Other salaries and wages', 'deduction'],
  ['ix_8', 'IX 8', 'Pension plan accruals and contributions', 'deduction'],
  ['ix_9', 'IX 9', 'Other employee benefits', 'deduction'],
  ['ix_10', 'IX 10', 'Payroll taxes', 'deduction'],
  ['ix_11g', 'IX 11g', 'Fees for services: other', 'deduction'],
  ['ix_12', 'IX 12', 'Advertising and promotion', 'deduction'],
  ['ix_13', 'IX 13', 'Office expenses', 'deduction'],
  ['ix_14', 'IX 14', 'Information technology', 'deduction'],
  ['ix_15', 'IX 15', 'Royalties', 'deduction'],
  ['ix_16', 'IX 16', 'Occupancy', 'deduction'],
  ['ix_17', 'IX 17', 'Travel', 'deduction'],
  ['ix_20', 'IX 20', 'Interest', 'deduction'],
  ['ix_22', 'IX 22', 'Depreciation, depletion, and amortization', 'deduction'],
  ['ix_23', 'IX 23', 'Insurance', 'deduction'],
  ['ix_24f', 'IX 24f', 'All other expenses', 'other_deduction'],
  ['x', 'X', 'Balance sheet (Part X)', 'balance_sheet'],
];

function rowsFor(form: TaxReturnForm, layout: Layout): readonly Row[] {
  switch (form) {
    case 'sch_c':
      return schCRows(layout);
    case 'f1065':
      return F1065_ROWS;
    case 'f1120s':
      return F1120S_ROWS;
    case 'f1120':
      return F1120_ROWS;
    case 'f990':
      return F990_ROWS;
  }
}

const catalogCache = new Map<string, TaxLineDef[]>();

function catalogFor(form: TaxReturnForm, layout: Layout): TaxLineDef[] {
  const cacheKey = `${form}:${layout}`;
  let catalog = catalogCache.get(cacheKey);
  if (!catalog) {
    catalog = build(form, rowsFor(form, layout));
    catalogCache.set(cacheKey, catalog);
  }
  return catalog;
}

/** All lines of a return for a tax year. A fresh array; the definitions are shared. */
export function getTaxLineCatalog(form: TaxReturnForm, taxYear: number): TaxLineDef[] {
  return [...catalogFor(form, layoutFor(form, taxYear))];
}

/** A line by its code (`sch_c.8`) for a tax year. Undefined for an unknown form or line. */
export function getTaxLine(code: string, taxYear: number): TaxLineDef | undefined {
  const dot = code.indexOf('.');
  if (dot <= 0) return undefined;
  const form = code.slice(0, dot);
  if (!isTaxReturnForm(form)) return undefined;
  return catalogFor(form, layoutFor(form, taxYear)).find((line) => line.code === code);
}

// ---------------------------------------------------------------------------
// Category -> line mapping
// ---------------------------------------------------------------------------

/** Schedule C "other expenses": 27a through 2024, 27b from 2025. */
const SCH_C_OTHER_EXPENSES = '27*';

/** Line keys per form, in the order [sch_c, f1065, f1120s, f1120, f990]. */
type FormKeys = readonly [string, string, string, string, string];

const FORM_COLUMN: Record<TaxReturnForm, 0 | 1 | 2 | 3 | 4> = {
  sch_c: 0,
  f1065: 1,
  f1120s: 2,
  f1120: 3,
  f990: 4,
};

const O = SCH_C_OTHER_EXPENSES;

/**
 * Where each category lands. Notes on the less obvious rows:
 * - Schedule C has no line for bad debts, amortization or royalties paid:
 *   they go to other expenses (line 48 detail, line 27 total).
 * - 1065 page 1 has no advertising, insurance, travel and similar lines; they
 *   are "other deductions" (line 21). 1120-S and 1120 likewise (lines 20 / 26).
 * - Officer pay and guaranteed payments are not deductible on Schedule C (the
 *   owner is paid from profit). For a partnership, officer pay is guaranteed
 *   payments; for an S corp or C corporation, guaranteed payments are officer pay.
 * - Interest income is separately stated for 1065 and 1120-S (Schedule K), and
 *   a Schedule C filer reports it on Form 1040.
 * - Nondeductible items go to the nondeductible line of the form: Schedule K
 *   (1065 18c, 1120-S 16c) or Schedule M-1 (1120). Schedule C simply doesn't
 *   take them.
 * - Form 990 is not a tax-deduction return: expenses map to the functional
 *   expense lines of Part IX, revenue to Part VIII.
 */
const TAX_LINE_MAP: Record<TaxLineCategory, FormKeys> = {
  // Income
  gross_receipts: ['1', '1a', '1a', '1a', 'viii_2'],
  returns_allowances: ['2', '1b', '1b', '1b', 'viii_2'],
  other_income: ['6', '7', '5', '10', 'viii_11'],
  interest_income: ['f1040', 'k5', 'k4', '5', 'viii_3'],
  gain_loss_on_disposal: ['f1040', '6', '4', '9', 'viii_7'],
  contributions_grants: ['6', '7', '5', '10', 'viii_1f'],
  membership_dues: ['1', '1a', '1a', '1a', 'viii_1b'],
  // Cost of goods sold
  cogs_beginning_inventory: ['35', '1125a_1', '1125a_1', '1125a_1', 'viii_10b'],
  cogs_purchases: ['36', '1125a_2', '1125a_2', '1125a_2', 'viii_10b'],
  cogs_labor: ['37', '1125a_3', '1125a_3', '1125a_3', 'viii_10b'],
  cogs_materials: ['38', '1125a_2', '1125a_2', '1125a_2', 'viii_10b'],
  cogs_other: ['39', '1125a_5', '1125a_5', '1125a_5', 'viii_10b'],
  cogs_ending_inventory: ['41', '1125a_7', '1125a_7', '1125a_7', 'viii_10b'],
  // Deductions
  advertising: ['8', '21', '16', '22', 'ix_12'],
  car_truck: ['9', '21', '20', '26', 'ix_17'],
  commissions_fees: ['10', '21', '20', '26', 'ix_11g'],
  contract_labor: ['11', '21', '20', '26', 'ix_11g'],
  depreciation: ['13', '16a', '14', '20', 'ix_22'],
  amortization: [O, '21', '20', '26', 'ix_22'],
  employee_benefits: ['14', '19', '18', '24', 'ix_9'],
  insurance: ['15', '21', '20', '26', 'ix_23'],
  interest_mortgage: ['16a', '15', '13', '18', 'ix_20'],
  interest_other: ['16b', '15', '13', '18', 'ix_20'],
  legal_professional: ['17', '21', '20', '26', 'ix_11g'],
  office_expense: ['18', '21', '20', '26', 'ix_13'],
  pension: ['19', '18', '17', '23', 'ix_8'],
  rent_vehicles_equipment: ['20a', '13', '11', '16', 'ix_16'],
  rent_other: ['20b', '13', '11', '16', 'ix_16'],
  repairs: ['21', '11', '9', '14', 'ix_16'],
  supplies: ['22', '21', '20', '26', 'ix_13'],
  taxes_licenses: ['23', '14', '12', '17', 'ix_24f'],
  payroll_taxes: ['23', '14', '12', '17', 'ix_10'],
  travel: ['24a', '21', '20', '26', 'ix_17'],
  meals: ['24b', '21', '20', '26', 'ix_24f'],
  utilities: ['25', '21', '20', '26', 'ix_16'],
  wages: ['26', '9', '8', '13', 'ix_7'],
  officer_compensation: ['nd', '10', '7', '12', 'ix_5'],
  guaranteed_payments: ['nd', '10', '7', '12', 'ix_5'],
  bad_debts: [O, '12', '10', '15', 'ix_24f'],
  charitable: ['nd', 'k13a', 'k12a', '19', 'ix_1'],
  home_office: ['30', '21', '20', '26', 'ix_16'],
  royalties: [O, '21', '20', '26', 'ix_15'],
  other_expenses: [O, '21', '20', '26', 'ix_24f'],
  // Nondeductible
  penalties_nondeductible: ['nd', 'k18c', 'k16c', 'm1_5', 'ix_24f'],
  federal_income_tax: ['nd', 'k18c', 'k16c', 'm1_2', 'ix_24f'],
  // Balance sheet
  balance_sheet: ['bs', 'l_other', 'l_other', 'l_other', 'x'],
  bs_cash: ['bs', 'l1', 'l1', 'l1', 'x'],
  bs_receivables: ['bs', 'l2a', 'l2a', 'l2a', 'x'],
  bs_inventory: ['bs', 'l3', 'l3', 'l3', 'x'],
  bs_other_current_assets: ['bs', 'l6', 'l6', 'l6', 'x'],
  bs_land: ['bs', 'l11', 'l12', 'l12', 'x'],
  bs_fixed_assets: ['bs', 'l9a', 'l10a', 'l10a', 'x'],
  bs_accumulated_depreciation: ['bs', 'l9b', 'l10b', 'l10b', 'x'],
  bs_payables: ['bs', 'l15', 'l16', 'l16', 'x'],
  bs_other_current_liabilities: ['bs', 'l17', 'l18', 'l18', 'x'],
  bs_long_term_debt: ['bs', 'l19b', 'l20', 'l20', 'x'],
  bs_capital: ['bs', 'l21', 'l22', 'l22', 'x'],
  bs_apic: ['bs', 'l21', 'l23', 'l23', 'x'],
  bs_retained_earnings: ['bs', 'l21', 'l24', 'l25', 'x'],
  bs_distributions: ['bs', 'm2_6', 'm2_7', 'm2_5', 'x'],
};

function resolveKey(key: string, form: TaxReturnForm, layout: Layout): string {
  if (key !== SCH_C_OTHER_EXPENSES) return key;
  // `27*` only appears in the Schedule C column.
  return form === 'sch_c' && layout === 'v2025' ? '27b' : '27a';
}

/**
 * The line of `form` a chart row's tax-line category lands on for `taxYear`.
 * Undefined for a category that isn't in `TAX_LINE_CATEGORIES`.
 */
export function resolveTaxLine(category: string, form: TaxReturnForm, taxYear: number): TaxLineDef | undefined {
  if (!isTaxLineCategory(category)) return undefined;
  const layout = layoutFor(form, taxYear);
  const key = resolveKey(TAX_LINE_MAP[category][FORM_COLUMN[form]], form, layout);
  return catalogFor(form, layout).find((line) => line.code === `${form}.${key}`);
}

/**
 * Where the nondeductible share of a partly deductible category goes (the 50%
 * of meals the return doesn't allow): Schedule K or M-1, nothing on Schedule C
 * or Form 990. Undefined when the category is fully deductible or the form has
 * no such line.
 */
export function resolveNondeductibleLine(category: string, form: TaxReturnForm, taxYear: number): TaxLineDef | undefined {
  if (getDeductiblePercent(category) >= 100) return undefined;
  const code: Record<TaxReturnForm, string | undefined> = {
    sch_c: undefined,
    f1065: 'f1065.k18c',
    f1120s: 'f1120s.k16c',
    f1120: 'f1120.m1_5c',
    f990: undefined,
  };
  const target = code[form];
  return target ? getTaxLine(target, taxYear) : undefined;
}
