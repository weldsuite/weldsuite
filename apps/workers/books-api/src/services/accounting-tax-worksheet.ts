/**
 * Income-tax return worksheet: the entity's trial balance for a fiscal year
 * grouped by the lines of its return (Schedule C, 1065, 1120-S, 1120 or 990),
 * with the accounts behind every line, for the accountant who prepares it.
 *
 * Each account carries a tax line (`accounts.tax_line`, e.g. `sch_c.8`). The
 * catalog of the entity's form for the tax year gives the lines, their order
 * and their sections. Amounts are shown the way the form shows them: income,
 * deductions and credit-side balance sheet lines positive, and a line made up
 * only of contra accounts (returns and allowances, accumulated depreciation)
 * positive in its own direction.
 *
 * Profit and loss accounts use the fiscal year's activity; balance sheet
 * accounts (Schedule L) their balance at the end of the year, and at the start
 * of it for the beginning-of-year column.
 */

import { addDays, parseIso } from '@weldsuite/books-domain/us-compliance/dates';
import {
  TAX_FORM_LABELS,
  TAX_LINE_CATEGORY_KEYS,
  getDeductiblePercent,
  getTaxLine,
  getTaxLineCatalog,
  resolveNondeductibleLine,
  resolveTaxLine,
  type TaxLineDef,
  type TaxLineSection,
  type TaxReturnForm,
} from '@weldsuite/books-domain/jurisdictions/us/tax-lines';
import { parseReportDate, type Ledger, type LedgerAccount } from './accounting-reports-basis';
import { money } from './accounting-reports';
import type { DateRange } from './accounting-report-periods';
import type { ReportTable, ReportTableColumn, ReportTableRow } from './accounting-report-export';

const BALANCE_SHEET_TYPES = ['asset', 'liability', 'equity'];

const SECTION_ORDER: TaxLineSection[] = [
  'income',
  'other_income',
  'cogs',
  'deduction',
  'other_deduction',
  'not_deductible',
  'balance_sheet',
  'equity',
];

export const TAX_SECTION_LABELS: Record<TaxLineSection, string> = {
  income: 'Income',
  other_income: 'Other income',
  cogs: 'Cost of goods sold',
  deduction: 'Deductions',
  other_deduction: 'Other deductions',
  not_deductible: 'Not deductible (Schedule K / M-1)',
  balance_sheet: 'Balance sheet (Schedule L)',
  equity: 'Equity (Schedule L / M-2)',
};

/** Which side a section normally carries; a line made up only of the other side flips. */
const SECTION_SIDE: Record<TaxLineSection, 'credit' | 'debit'> = {
  income: 'credit',
  other_income: 'credit',
  cogs: 'debit',
  deduction: 'debit',
  other_deduction: 'debit',
  not_deductible: 'debit',
  balance_sheet: 'debit',
  equity: 'credit',
};

export interface TaxWorksheetAccount {
  accountId: string;
  code: string;
  name: string;
  type: string;
  /** Normalised like the line it sits on. */
  amount: string;
  /** Balance sheet accounts: the balance at the start of the fiscal year. */
  beginningAmount?: string;
}

export interface TaxWorksheetLine {
  code: string;
  line: string;
  label: string;
  section: TaxLineSection;
  /** `credit` or `debit`: the side `amount` is positive on. */
  side: 'credit' | 'debit';
  amount: string;
  /** Balance sheet lines: the amount at the start of the fiscal year. */
  beginningAmount?: string;
  /** Only part of the book amount is deductible (meals, 50%). */
  deductiblePercent?: number;
  deductibleAmount?: string;
  nonDeductibleAmount?: string;
  /** Where the non-deductible part is reported, when the form has such a line. */
  nonDeductibleLine?: string;
  accounts: TaxWorksheetAccount[];
}

export interface TaxWorksheetSection {
  key: TaxLineSection;
  label: string;
  lines: TaxWorksheetLine[];
  /** Income sections credit-positive, expense sections debit-positive; null where the lines mix assets and liabilities. */
  total: string | null;
}

export interface TaxWorksheetUnmapped {
  accountId: string;
  code: string;
  name: string;
  type: string;
  taxLine: string | null;
  /** `none`: no line set. `other_form`: set to a line of another return (re-map after changing the classification). */
  reason: 'none' | 'other_form' | 'unknown_line';
  amount: string;
  beginningAmount?: string;
}

export interface TaxWorksheet {
  form: TaxReturnForm;
  formLabel: string;
  taxYear: number;
  basis: string;
  period: DateRange;
  entity: { id: string; name: string; legalName: string | null; entityType: string | null; taxClassification: string | null };
  sections: TaxWorksheetSection[];
  unmapped: TaxWorksheetUnmapped[];
  summary: {
    /** Revenue minus expenses over every account of the year, mapped or not. */
    netIncomePerBooks: string;
    totalIncome: string;
    totalOtherIncome: string;
    totalCostOfGoodsSold: string;
    totalDeductions: string;
    /** Income minus cost of goods sold and deductions, from the mapped lines. */
    netIncomeFromLines: string;
    notDeductibleTotal: string;
    /** Unmapped profit and loss accounts, revenue minus expense. */
    unmappedNetIncome: string;
    /** Books net income equals the lines' net income less the non-deductible lines plus the unmapped accounts. */
    reconciles: boolean;
  };
}

/** Lines that only partly count: meals, the deductible share of a category no other category shares a line with. */
function limitedLines(form: TaxReturnForm, taxYear: number) {
  const limited = new Map<string, { percent: number; nonDeductibleLine?: string }>();
  const full = new Set<string>();
  for (const category of TAX_LINE_CATEGORY_KEYS) {
    const line = resolveTaxLine(category, form, taxYear);
    if (!line) continue;
    const percent = getDeductiblePercent(category);
    if (percent < 100) {
      limited.set(line.code, { percent, nonDeductibleLine: resolveNondeductibleLine(category, form, taxYear)?.code });
    } else {
      full.add(line.code);
    }
  }
  for (const code of full) limited.delete(code);
  return limited;
}

export async function buildTaxWorksheet(
  ledger: Ledger,
  entity: TaxWorksheet['entity'],
  form: TaxReturnForm,
  range: DateRange,
  includeZeroAccounts = false,
): Promise<TaxWorksheet> {
  const taxYear = parseIso(range.from).y;
  const catalog = getTaxLineCatalog(form, taxYear);
  const limits = limitedLines(form, taxYear);

  const periodRange = { from: parseReportDate(range.from, 'start'), to: parseReportDate(range.to, 'end') };
  const [activity, endBalances, startBalances] = await Promise.all([
    ledger.aggregate(periodRange, { accountTypes: ['revenue', 'expense'] }),
    ledger.aggregate({ from: null, to: periodRange.to }, { accountTypes: BALANCE_SHEET_TYPES }),
    ledger.aggregate(
      { from: null, to: new Date(periodRange.from.getTime() - 1) },
      { accountTypes: BALANCE_SHEET_TYPES },
    ),
  ]);
  const activityBy = new Map(activity.map((r) => [r.accountId, { debit: r.debit, credit: r.credit }]));
  const endBy = new Map(endBalances.map((r) => [r.accountId, { debit: r.debit, credit: r.credit }]));
  const startBy = new Map(startBalances.map((r) => [r.accountId, { debit: r.debit, credit: r.credit }]));

  interface Placed {
    account: LedgerAccount;
    /** Debit minus credit over the year (P&L) or at year end (balance sheet). */
    net: number;
    beginningNet?: number;
    debit: number;
    credit: number;
  }
  const placed: Placed[] = [];
  for (const account of ledger.accounts.values()) {
    const isBalanceSheet = BALANCE_SHEET_TYPES.includes(account.type);
    const totals = isBalanceSheet ? endBy.get(account.id) : activityBy.get(account.id);
    const start = isBalanceSheet ? startBy.get(account.id) : undefined;
    const net = (totals?.debit ?? 0) - (totals?.credit ?? 0);
    const beginningNet = start ? start.debit - start.credit : isBalanceSheet ? 0 : undefined;
    const hasAmount = Math.abs(net) >= 0.005 || Math.abs(beginningNet ?? 0) >= 0.005;
    if (!hasAmount && !includeZeroAccounts) continue;
    placed.push({ account, net, beginningNet, debit: totals?.debit ?? 0, credit: totals?.credit ?? 0 });
  }
  placed.sort((a, b) => a.account.code.localeCompare(b.account.code, 'en', { numeric: true }));

  const catalogByCode = new Map(catalog.map((l) => [l.code, l]));
  const byLine = new Map<string, Placed[]>();
  const unmapped: TaxWorksheetUnmapped[] = [];

  for (const p of placed) {
    const code = p.account.taxLine;
    const def = code ? (catalogByCode.get(code) ?? undefined) : undefined;
    if (def) {
      const list = byLine.get(def.code) ?? [];
      list.push(p);
      byLine.set(def.code, list);
      continue;
    }
    // Schedule C has no balance sheet to map accounts to.
    if (form === 'sch_c' && BALANCE_SHEET_TYPES.includes(p.account.type)) continue;
    let reason: TaxWorksheetUnmapped['reason'] = 'none';
    if (code) reason = getTaxLine(code, taxYear) ? 'other_form' : 'unknown_line';
    const credit = p.account.normalSide === 'credit';
    unmapped.push({
      accountId: p.account.id,
      code: p.account.code,
      name: p.account.name,
      type: p.account.type,
      taxLine: code,
      reason,
      amount: money(credit ? -p.net : p.net),
      ...(p.beginningNet !== undefined ? { beginningAmount: money(credit ? -p.beginningNet : p.beginningNet) } : {}),
    });
  }

  const lines: TaxWorksheetLine[] = catalog.map((def: TaxLineDef) => {
    const members = byLine.get(def.code) ?? [];
    const sectionSide = SECTION_SIDE[def.section];
    // A line holding only contra accounts (debit-natural revenue, credit-natural assets) reads positive on its own side.
    const side: 'credit' | 'debit' =
      members.length > 0 && members.every((m) => m.account.normalSide !== sectionSide) ? (sectionSide === 'credit' ? 'debit' : 'credit') : sectionSide;
    const signed = (net: number) => (side === 'debit' ? net : -net);
    const amount = members.reduce((total, m) => total + signed(m.net), 0);
    const isBalanceSheet = def.section === 'balance_sheet' || def.section === 'equity';
    const beginning = members.reduce((total, m) => total + signed(m.beginningNet ?? 0), 0);

    const line: TaxWorksheetLine = {
      code: def.code,
      line: def.line,
      label: def.label,
      section: def.section,
      side,
      amount: money(amount),
      ...(isBalanceSheet ? { beginningAmount: money(beginning) } : {}),
      accounts: members.map((m) => ({
        accountId: m.account.id,
        code: m.account.code,
        name: m.account.name,
        type: m.account.type,
        amount: money(signed(m.net)),
        ...(m.beginningNet !== undefined ? { beginningAmount: money(signed(m.beginningNet)) } : {}),
      })),
    };
    const limit = limits.get(def.code);
    if (limit && members.length > 0) {
      const deductible = (amount * limit.percent) / 100;
      line.deductiblePercent = limit.percent;
      line.deductibleAmount = money(deductible);
      line.nonDeductibleAmount = money(amount - deductible);
      if (limit.nonDeductibleLine) line.nonDeductibleLine = limit.nonDeductibleLine;
    }
    return line;
  });

  // Section totals: a line on the other side of its section (returns in income) subtracts.
  const sections: TaxWorksheetSection[] = [];
  for (const key of SECTION_ORDER) {
    const sectionLines = lines.filter((l) => l.section === key);
    if (sectionLines.length === 0) continue;
    const mixes = key === 'balance_sheet';
    const total = sectionLines.reduce((sum, l) => sum + (l.side === SECTION_SIDE[key] ? Number(l.amount) : -Number(l.amount)), 0);
    sections.push({ key, label: TAX_SECTION_LABELS[key], lines: sectionLines, total: mixes ? null : money(total) });
  }

  const sectionTotal = (key: TaxLineSection) => Number(sections.find((s) => s.key === key)?.total ?? 0);
  const totalIncome = sectionTotal('income');
  const totalOtherIncome = sectionTotal('other_income');
  const totalCogs = sectionTotal('cogs');
  const totalDeductions = sectionTotal('deduction') + sectionTotal('other_deduction');
  const netFromLines = totalIncome + totalOtherIncome - totalCogs - totalDeductions;
  const notDeductible = sectionTotal('not_deductible');

  let booksNet = 0;
  for (const p of placed) {
    if (p.account.type === 'revenue') booksNet += -p.net;
    else if (p.account.type === 'expense') booksNet -= p.net;
  }
  let unmappedNet = 0;
  for (const u of unmapped) {
    const p = placed.find((x) => x.account.id === u.accountId);
    if (!p) continue;
    if (p.account.type === 'revenue') unmappedNet += -p.net;
    else if (p.account.type === 'expense') unmappedNet -= p.net;
  }

  return {
    form,
    formLabel: TAX_FORM_LABELS[form],
    taxYear,
    basis: ledger.basis,
    period: range,
    entity,
    sections,
    unmapped,
    summary: {
      netIncomePerBooks: money(booksNet),
      totalIncome: money(totalIncome),
      totalOtherIncome: money(totalOtherIncome),
      totalCostOfGoodsSold: money(totalCogs),
      totalDeductions: money(totalDeductions),
      netIncomeFromLines: money(netFromLines),
      notDeductibleTotal: money(notDeductible),
      unmappedNetIncome: money(unmappedNet),
      reconciles: Math.abs(booksNet - (netFromLines - notDeductible + unmappedNet)) < 0.01,
    },
  };
}

/** Day the fiscal year before this one ended; the worksheet's beginning balances are as of it. */
export function beginningBalanceDate(range: DateRange): string {
  return addDays(range.from, -1);
}

export function taxWorksheetTable(worksheet: TaxWorksheet): ReportTable {
  const hasBeginning = worksheet.sections.some((s) => s.lines.some((l) => l.beginningAmount !== undefined));
  const columns: ReportTableColumn[] = [
    { key: 'line', label: 'Line', numeric: false },
    { key: 'amount', label: 'Amount', numeric: true },
    ...(hasBeginning ? [{ key: 'beginning', label: 'Beginning of year', numeric: true }] : []),
    { key: 'deductible', label: 'Deductible', numeric: true },
  ];

  const rows: ReportTableRow[] = [];
  for (const section of worksheet.sections) {
    rows.push({ kind: 'section', depth: 0, label: section.label, values: {} });
    for (const line of section.lines) {
      const hasAccounts = line.accounts.length > 0;
      // Lines without accounts stay in the export: the accountant sees the whole form.
      rows.push({
        kind: 'account',
        depth: 0,
        label: line.label,
        code: line.code,
        values: {
          line: line.line,
          amount: line.amount,
          beginning: line.beginningAmount ?? null,
          deductible: line.deductibleAmount ?? null,
        },
      });
      if (hasAccounts) {
        for (const account of line.accounts) {
          rows.push({
            kind: 'note',
            depth: 1,
            label: `${account.code} ${account.name}`.trim(),
            values: { amount: account.amount, beginning: account.beginningAmount ?? null },
          });
        }
      }
    }
    if (section.total !== null) rows.push({ kind: 'subtotal', depth: 0, label: `Total ${section.label.toLowerCase()}`, values: { amount: section.total } });
  }

  if (worksheet.unmapped.length > 0) {
    rows.push({ kind: 'section', depth: 0, label: 'Accounts without a tax line', values: {} });
    for (const u of worksheet.unmapped) {
      rows.push({
        kind: 'note',
        depth: 1,
        label: `${u.code} ${u.name}`.trim(),
        values: { amount: u.amount, beginning: u.beginningAmount ?? null },
      });
    }
  }

  const s = worksheet.summary;
  rows.push(
    { kind: 'section', depth: 0, label: 'Summary', values: {} },
    { kind: 'subtotal', depth: 0, label: 'Net income per books', values: { amount: s.netIncomePerBooks } },
    { kind: 'subtotal', depth: 0, label: 'Net income from tax lines', values: { amount: s.netIncomeFromLines } },
    { kind: 'subtotal', depth: 0, label: 'Not deductible', values: { amount: s.notDeductibleTotal } },
    { kind: 'subtotal', depth: 0, label: 'Accounts without a tax line (net)', values: { amount: s.unmappedNetIncome } },
  );

  const notes = [
    `${worksheet.formLabel}, tax year ${worksheet.taxYear}, ${worksheet.basis} basis.`,
    `Fiscal year ${worksheet.period.from} to ${worksheet.period.to}; balance sheet lines are as of ${worksheet.period.to}, beginning amounts as of ${beginningBalanceDate(worksheet.period)}.`,
  ];
  if (!s.reconciles) notes.push('The lines do not reconcile to net income per books; check the accounts without a tax line.');
  return { report: 'tax_worksheet', title: `Tax return worksheet: ${worksheet.formLabel}`, hasCode: true, columns, rows, notes };
}
