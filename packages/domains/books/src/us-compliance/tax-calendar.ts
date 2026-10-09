/**
 * Income tax, information return, payroll and sales tax due dates for a US
 * entity, each moved to the next business day when it falls on a weekend or a
 * legal holiday in the District of Columbia (IRC section 7503; see
 * federal-holidays.ts, which includes DC Emancipation Day on 16 April).
 *
 * Every deadline has a stable `key` (`f1120s:2026`, `sales_tax:<agencyId>:2026-09-30`,
 * `1099_nec_recipient:2026`) that the tax_calendar_completions table keys on.
 *
 * Rules (docs/plans/weldbooks-us-research/federal.md sections 3, 5, 7, 8):
 * - Schedule C / Form 1040: 15 April; Form 4868 extends to 15 October.
 * - Forms 1065 and 1120-S: 15th day of the 3rd month after year end; Form 7004
 *   extends by 6 months.
 * - Form 1120: 15th day of the 4th month; Form 7004 extends by 6 months. C
 *   corporations with a 30 June year end keep the 3rd month (and a 7 month
 *   extension) for tax years beginning before 1 January 2026.
 * - Form 990: 15th day of the 5th month; Form 8868 extends by 6 months.
 * - Estimated tax: owners of pass-through entities pay on Form 1040-ES (15
 *   April, 15 June, 15 September, 15 January); C corporations pay four
 *   installments on the 15th of the 4th, 6th, 9th and 12th months of the tax
 *   year (Form 1120-W).
 * - For a 52-53-week year the month a year "ends in" is its end month, so a
 *   year ending on 2 January 2027 with end month December is a December year.
 *   This follows the reading that a 52-53-week year ending within days of a
 *   month end is treated as ending in that month; confirm with a tax adviser.
 *
 * Sales tax periods follow the agency's frequency from its first period start;
 * due dates use federal holidays, which differ from some states' own.
 */

import { form1099Deadlines } from '../jurisdictions/us/form-1099';
import { addMonths, dateIn, diffDays, endOfMonth, formatIso, parseIso, startOfMonth } from './dates';
import { rollToBusinessDay } from './federal-holidays';
import { fiscalYearFor, type FiscalYearConfig } from './fiscal-year';

/** Income tax return the entity files (entity-types.ts maps entity types to these). */
export type TaxReturnForm = 'sch_c' | 'f1065' | 'f1120s' | 'f1120' | 'f990';

export type TaxDeadlineKind =
  | 'income_tax_return'
  | 'income_tax_extended_return'
  | 'estimated_tax'
  | 'information_return'
  | 'payroll'
  | 'sales_tax';

export interface TaxDeadline {
  /** Stable id for completion tracking. */
  key: string;
  kind: TaxDeadlineKind;
  title: string;
  /** The date to meet: the statutory date moved to the next business day. */
  dueDate: string;
  /** The statutory date before moving. */
  nominalDate: string;
  /** Form or filing, e.g. `f1120s`, `1040es`, `1099_nec`, `941`, `sales_tax`. */
  form: string;
  /** Tax or fiscal year the deadline belongs to. */
  taxYear?: number;
  periodStart?: string;
  periodEnd?: string;
  agencyId?: string;
  stateCode?: string | null;
  /** The extension form that produced an extended date. */
  extensionForm?: string;
  /** Shown for information; not something the entity files with a return of its own (payroll items). */
  informational?: boolean;
  note?: string;
}

export interface TaxCalendarEntity {
  form: TaxReturnForm;
  /** Defaults to the calendar year. Schedule C filers always use the owner's calendar year. */
  fiscalYear?: FiscalYearConfig;
  hasPayroll?: boolean;
  /** Pays contractors and files 1099s (default true). */
  files1099?: boolean;
  /** Withheld backup withholding during the year, so Form 945 applies. */
  hasBackupWithholding?: boolean;
}

export type AgencyFilingFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export interface SalesTaxAgencyInput {
  id: string;
  name?: string;
  stateCode?: string | null;
  filingFrequency: AgencyFilingFrequency;
  /** Day of the month after the period; `last` = last day. */
  dueDay: number | 'last';
  /** First day of the first period (the grid of periods follows from its month). */
  firstPeriodStart: string | null;
  /** Registration end; periods starting after it are left out. */
  registeredUntil?: string | null;
  status?: string | null;
}

const CALENDAR_YEAR: FiscalYearConfig = { type: 'month', startMonth: 1 };

const FORM_LABEL: Record<TaxReturnForm, string> = {
  sch_c: 'Schedule C (Form 1040)',
  f1065: 'Form 1065',
  f1120s: 'Form 1120-S',
  f1120: 'Form 1120',
  f990: 'Form 990',
};

const EXTENSION_FORM: Record<TaxReturnForm, string> = {
  sch_c: 'Form 4868',
  f1065: 'Form 7004',
  f1120s: 'Form 7004',
  f1120: 'Form 7004',
  f990: 'Form 8868',
};

/** Month the fiscal year ends in. */
function endMonthOf(config: FiscalYearConfig): number {
  if (config.type === 'fifty_two_fifty_three') return Math.min(12, Math.max(1, Math.trunc(config.endMonth)));
  const start = Math.min(12, Math.max(1, Math.trunc(config.startMonth)));
  return start === 1 ? 12 : start - 1;
}

function deadline(
  partial: Omit<TaxDeadline, 'dueDate' | 'nominalDate'> & { nominalDate: string },
): TaxDeadline {
  return { ...partial, dueDate: rollToBusinessDay(partial.nominalDate) };
}

function byDueDate(a: TaxDeadline, b: TaxDeadline): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/** Return, extension and estimated tax deadlines of one fiscal year (named for the year its end month falls in). */
export function incomeTaxDeadlines(entity: TaxCalendarEntity, fiscalYear: number): TaxDeadline[] {
  const config = entity.form === 'sch_c' ? CALENDAR_YEAR : (entity.fiscalYear ?? CALENDAR_YEAR);
  const year = fiscalYearFor(config, fiscalYear);
  const endMonth = endMonthOf(config);
  const label = FORM_LABEL[entity.form];
  const out: TaxDeadline[] = [];

  let monthsAfterEnd: number;
  let extensionMonths = 6;
  switch (entity.form) {
    case 'sch_c':
      monthsAfterEnd = 4;
      break;
    case 'f1065':
    case 'f1120s':
      monthsAfterEnd = 3;
      break;
    case 'f1120':
      monthsAfterEnd = 4;
      if (config.type === 'month' && endMonth === 6 && year.start < '2026-01-01') {
        monthsAfterEnd = 3;
        extensionMonths = 7;
      }
      break;
    case 'f990':
      monthsAfterEnd = 5;
      break;
  }

  const base = {
    form: entity.form,
    taxYear: fiscalYear,
    periodStart: year.start,
    periodEnd: year.end,
  };
  const nominal = dateIn(fiscalYear, endMonth + monthsAfterEnd, 15);
  out.push(
    deadline({
      ...base,
      key: `${entity.form}:${fiscalYear}`,
      kind: 'income_tax_return',
      title: `${label}, tax year ${fiscalYear}`,
      nominalDate: nominal,
      note: `File ${EXTENSION_FORM[entity.form]} by this date to extend.`,
    }),
  );
  // The extension runs from the statutory (unmoved) date.
  out.push(
    deadline({
      ...base,
      key: `${entity.form}:${fiscalYear}:extended`,
      kind: 'income_tax_extended_return',
      title: `${label}, tax year ${fiscalYear}, extended`,
      nominalDate: addMonths(nominal, extensionMonths),
      extensionForm: EXTENSION_FORM[entity.form],
    }),
  );

  if (entity.form === 'f1120') {
    ['q1', 'q2', 'q3', 'q4'].forEach((quarter, index) => {
      const offset = [-8, -6, -3, 0][index]!;
      out.push(
        deadline({
          key: `1120w:${fiscalYear}:${quarter}`,
          kind: 'estimated_tax',
          title: `Form 1120-W estimated tax, installment ${index + 1}, tax year ${fiscalYear}`,
          form: '1120w',
          taxYear: fiscalYear,
          nominalDate: dateIn(fiscalYear, endMonth + offset, 15),
        }),
      );
    });
  }
  return out;
}

/** Owners of sole proprietorships and pass-through entities pay Form 1040-ES on their calendar year. */
export function estimatedTaxDeadlines(taxYear: number): TaxDeadline[] {
  const dates = [formatIso(taxYear, 4, 15), formatIso(taxYear, 6, 15), formatIso(taxYear, 9, 15), formatIso(taxYear + 1, 1, 15)];
  return dates.map((nominalDate, index) =>
    deadline({
      key: `1040es:${taxYear}:q${index + 1}`,
      kind: 'estimated_tax',
      title: `Form 1040-ES estimated tax, installment ${index + 1}, tax year ${taxYear}`,
      form: '1040es',
      taxYear,
      nominalDate,
      note: 'Paid by the owner personally.',
    }),
  );
}

/** 1099-NEC / 1099-MISC deadlines of a tax year (calendar year, cash basis), plus Form 945 when backup withholding applies. */
export function information1099Deadlines(taxYear: number, options: { form945?: boolean } = {}): TaxDeadline[] {
  const d = form1099Deadlines(taxYear);
  const next = taxYear + 1;
  const nominalJan31 = formatIso(next, 1, 31);
  const items: Array<[string, string, string, string]> = [
    ['1099_nec_recipient', '1099_nec', `Form 1099-NEC recipient copies, tax year ${taxYear}`, nominalJan31],
    ['1099_nec_irs', '1099_nec', `Form 1099-NEC to the IRS, tax year ${taxYear}`, nominalJan31],
    ['1099_misc_recipient', '1099_misc', `Form 1099-MISC recipient copies, tax year ${taxYear}`, nominalJan31],
    ['1099_misc_irs_paper', '1099_misc', `Form 1099-MISC to the IRS on paper, tax year ${taxYear}`, formatIso(next, 2, 28)],
    ['1099_misc_irs_electronic', '1099_misc', `Form 1099-MISC to the IRS electronically, tax year ${taxYear}`, formatIso(next, 3, 31)],
  ];
  const rolled: Record<string, string> = {
    '1099_nec_recipient': d.nec.recipient,
    '1099_nec_irs': d.nec.irs,
    '1099_misc_recipient': d.misc.recipient,
    '1099_misc_irs_paper': d.misc.irsPaper,
    '1099_misc_irs_electronic': d.misc.irsElectronic,
  };
  const out: TaxDeadline[] = items.map(([id, form, title, nominalDate]) => ({
    key: `${id}:${taxYear}`,
    kind: 'information_return' as const,
    title,
    form,
    taxYear,
    nominalDate,
    dueDate: rolled[id]!,
  }));
  if (options.form945) {
    out.push({
      key: `945:${taxYear}`,
      kind: 'information_return',
      title: `Form 945 backup withholding, tax year ${taxYear}`,
      form: '945',
      taxYear,
      nominalDate: nominalJan31,
      dueDate: d.form945,
    });
  }
  return out;
}

/** 941, 940 and W-2 deadlines of a calendar year. Informational: payroll is filed outside WeldBooks. */
export function payrollDeadlines(taxYear: number): TaxDeadline[] {
  const next = taxYear + 1;
  const quarters: Array<[string, string]> = [
    ['q1', formatIso(taxYear, 4, 30)],
    ['q2', formatIso(taxYear, 7, 31)],
    ['q3', formatIso(taxYear, 10, 31)],
    ['q4', formatIso(next, 1, 31)],
  ];
  const out: TaxDeadline[] = quarters.map(([quarter, nominalDate]) =>
    deadline({
      key: `941:${taxYear}:${quarter}`,
      kind: 'payroll',
      title: `Form 941, ${quarter.toUpperCase()} ${taxYear}`,
      form: '941',
      taxYear,
      nominalDate,
      informational: true,
    }),
  );
  out.push(
    deadline({
      key: `940:${taxYear}`,
      kind: 'payroll',
      title: `Form 940, tax year ${taxYear}`,
      form: '940',
      taxYear,
      nominalDate: formatIso(next, 1, 31),
      informational: true,
    }),
    deadline({
      key: `w2:${taxYear}`,
      kind: 'payroll',
      title: `Forms W-2 and W-3, tax year ${taxYear}`,
      form: 'w2',
      taxYear,
      nominalDate: formatIso(next, 1, 31),
      informational: true,
    }),
  );
  return out;
}

const PERIOD_MONTHS: Record<AgencyFilingFrequency, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

/**
 * Sales tax return periods and due dates of agencies whose due date falls
 * between `from` and `to` (inclusive). A period ends on the last day of its
 * last month; the return is due on `dueDay` of the following month.
 */
export function agencyDeadlines(agencies: SalesTaxAgencyInput[], from: string, to: string): TaxDeadline[] {
  const out: TaxDeadline[] = [];
  for (const agency of agencies) {
    if (!agency.firstPeriodStart || agency.status === 'closed' || agency.status === 'monitoring') continue;
    const length = PERIOD_MONTHS[agency.filingFrequency];
    const first = agency.firstPeriodStart;
    const anchor = startOfMonth(first);
    for (let index = 0; index < 1200; index += 1) {
      const gridStart = addMonths(anchor, index * length);
      if (gridStart > to) break;
      if (agency.registeredUntil && gridStart > agency.registeredUntil) break;
      const periodStart = index === 0 ? first : gridStart;
      const periodEnd = endOfMonth(addMonths(gridStart, length - 1));
      const { y, m } = parseIso(periodEnd);
      const nominalDate = agency.dueDay === 'last' ? endOfMonth(dateIn(y, m + 1, 1)) : dateIn(y, m + 1, agency.dueDay);
      const dueDate = rollToBusinessDay(nominalDate);
      if (dueDate < from || dueDate > to) continue;
      out.push({
        key: `sales_tax:${agency.id}:${periodEnd}`,
        kind: 'sales_tax',
        title: `${agency.name ?? agency.stateCode ?? 'Sales tax'} return, ${periodStart} to ${periodEnd}`,
        form: 'sales_tax',
        nominalDate,
        dueDate,
        periodStart,
        periodEnd,
        agencyId: agency.id,
        stateCode: agency.stateCode ?? null,
      });
    }
  }
  return out.sort(byDueDate);
}

export interface TaxCalendarOptions {
  agencies?: SalesTaxAgencyInput[];
}

/**
 * Every deadline of an entity that falls due in a calendar year, in date
 * order. Returns for tax year 2026 are due in 2027, so the calendar of 2027
 * holds them next to the 2027 estimated payments.
 */
export function taxCalendar(entity: TaxCalendarEntity, year: number, options: TaxCalendarOptions = {}): TaxDeadline[] {
  const from = formatIso(year, 1, 1);
  const to = formatIso(year, 12, 31);
  const all: TaxDeadline[] = [];

  for (let fiscalYear = year - 2; fiscalYear <= year + 1; fiscalYear += 1) {
    all.push(...incomeTaxDeadlines(entity, fiscalYear));
  }
  if (entity.form === 'sch_c' || entity.form === 'f1065' || entity.form === 'f1120s') {
    for (const taxYear of [year - 1, year]) all.push(...estimatedTaxDeadlines(taxYear));
  }
  for (const taxYear of [year - 1, year]) {
    if (entity.files1099 !== false) {
      all.push(...information1099Deadlines(taxYear, { form945: Boolean(entity.hasBackupWithholding) }));
    }
    if (entity.hasPayroll) all.push(...payrollDeadlines(taxYear));
  }
  if (options.agencies) all.push(...agencyDeadlines(options.agencies, from, to));

  const seen = new Set<string>();
  return all
    .filter((item) => item.dueDate >= from && item.dueDate <= to)
    .filter((item) => (seen.has(item.key) ? false : (seen.add(item.key), true)))
    .sort(byDueDate);
}

/** Days from `today` until a deadline (negative when overdue). */
export function daysUntil(today: string, dueDate: string): number {
  return diffDays(today, dueDate);
}
