/**
 * Positive Pay issued-check files: the list of checks a company has written
 * (and voided) that the bank matches against what is presented for payment.
 *
 * There is no common standard (federal.md section 9). Every bank publishes its
 * own layout and many differ in field order, date and amount format, padding,
 * void marking and header rows. So this module is a configurable builder with
 * two generic formats and a preset per bank:
 *
 * - `generic_csv` and `generic_fixed` are ours: account number, check number,
 *   issue date, amount, payee and a void flag. Every column, date format,
 *   amount format, delimiter and width can be overridden per bank account.
 * - `us_bank` is pre-filled from a third-party ERP vendor's help page for U.S.
 *   Bank's fixed-length "Single Point" issue file (see POSITIVE_PAY_FORMATS).
 *   It is the only bank layout found documented, and it is not from the bank
 *   itself: check it against the bank's current specification.
 * - `bofa`, `chase` and `wells_fargo` are templates only. Their specifications
 *   are not public, so they start as the generic CSV and say so; the company
 *   sets the columns to the layout the bank gave it, and runs the bank's test
 *   file before going live.
 *
 * What a file holds for a date range: the checks issued in the range, and the
 * checks voided in it (a check voided after the range is still an issue). A
 * check that is voided by the end of the range carries the void marking.
 */

import { isIsoDate, parseIso } from './dates';

export type PositivePayFormatId = 'generic_csv' | 'generic_fixed' | 'bofa' | 'chase' | 'wells_fargo' | 'us_bank';

export interface PositivePayFormatInfo {
  id: PositivePayFormatId;
  label: string;
  kind: 'csv' | 'fixed';
  /** Where the preset's layout comes from: our own, a third party's description, or nowhere (a blank template). */
  documentation: 'generic' | 'third_party' | 'none';
  /** The preset is a starting point the company must match to the bank's own specification. */
  needsBankSpec: boolean;
  note: string;
  sourceUrl?: string;
}

export const POSITIVE_PAY_FORMATS: readonly PositivePayFormatInfo[] = [
  {
    id: 'generic_csv',
    label: 'Generic CSV',
    kind: 'csv',
    documentation: 'generic',
    needsBankSpec: false,
    note: 'Account number, check number, issue date, amount, payee and void flag, comma separated with a header row. Columns, date and amount format are configurable.',
  },
  {
    id: 'generic_fixed',
    label: 'Generic fixed width',
    kind: 'fixed',
    documentation: 'generic',
    needsBankSpec: false,
    note: 'Account (12), check number (10), amount in cents (12), date MMDDYYYY (8), payee (40) and a void flag (1), no header. Field order and widths are configurable.',
  },
  {
    id: 'bofa',
    label: 'Bank of America (CashPro)',
    kind: 'csv',
    documentation: 'none',
    needsBankSpec: true,
    note: 'Template: the issue file specification is not public. Set the columns to the layout Bank of America gave you.',
  },
  {
    id: 'chase',
    label: 'Chase (ACCESS)',
    kind: 'csv',
    documentation: 'none',
    needsBankSpec: true,
    note: 'Template: Chase\'s issue file layout is not public. Set the columns to the layout Chase gave you.',
  },
  {
    id: 'wells_fargo',
    label: 'Wells Fargo (CEO)',
    kind: 'csv',
    documentation: 'none',
    needsBankSpec: true,
    note: 'Template: Wells Fargo\'s issue file layout is not public. Set the columns to the layout Wells Fargo gave you.',
  },
  {
    id: 'us_bank',
    label: 'U.S. Bank',
    kind: 'fixed',
    documentation: 'third_party',
    needsBankSpec: true,
    note: 'Fixed length: account (12, zero filled), check number (10, zero filled), amount (12, two implied decimals), date MMDDYYYY, action IS or CN, payee 1 (40), payee 2 (40, optional). From a third-party ERP help page, not from U.S. Bank: confirm it before use.',
    sourceUrl: 'https://support.storis.com/helpRevisions/StorisWebHelp98/Payables/Process_Checks/Actions_and_Field_Details/Bank_Check_File_Format_-_US_Bank.htm',
  },
];

export function isPositivePayFormat(value: unknown): value is PositivePayFormatId {
  return POSITIVE_PAY_FORMATS.some((format) => format.id === value);
}

export type PositivePayField =
  | 'account_number'
  | 'check_number'
  | 'issue_date'
  | 'amount'
  | 'payee'
  | 'void_flag'
  | 'void_date'
  | 'action_code'
  /** A constant (`literal`, empty by default): a column the bank wants but we have no value for. */
  | 'blank';

export type PositivePayDateFormat = 'MMDDYYYY' | 'MM/DD/YYYY' | 'YYYYMMDD' | 'YYYY-MM-DD' | 'MMDDYY' | 'MM/DD/YY';

/** `decimal`: 1234.56. `implied_decimal`: 123456 (cents, no decimal point). */
export type PositivePayAmountFormat = 'decimal' | 'implied_decimal';

export interface PositivePayColumn {
  field: PositivePayField;
  /** CSV header text. */
  header?: string;
  /** Fixed width: characters in the column. */
  width?: number;
  /** Fixed width: default right for account, check number and amount, left for the rest. */
  align?: 'left' | 'right';
  /** Fixed width: default `0` for account, check number and amount, a space for the rest. */
  pad?: ' ' | '0';
  /** Value of a `blank` column. */
  literal?: string;
}

export interface PositivePayConfig {
  kind: 'csv' | 'fixed';
  columns: PositivePayColumn[];
  dateFormat: PositivePayDateFormat;
  amountFormat: PositivePayAmountFormat;
  /** CSV: field delimiter. */
  delimiter: string;
  /** CSV: write a header row. */
  header: boolean;
  /** CSV: quote every field, not only those that need it. */
  quoteAll: boolean;
  /** Cell of `void_flag` for an issued check and for a void. */
  issueFlag: string;
  voidFlag: string;
  /** Cell of `action_code` for an issued check and for a void. */
  actionIssue: string;
  actionVoid: string;
  /** Payee is cut to this length (the bank's limit); no cut when unset. */
  payeeMaxLength?: number;
  uppercasePayee: boolean;
  lineEnding: '\r\n' | '\n';
}

const CSV_COLUMNS: PositivePayColumn[] = [
  { field: 'account_number', header: 'Account Number' },
  { field: 'check_number', header: 'Check Number' },
  { field: 'issue_date', header: 'Issue Date' },
  { field: 'amount', header: 'Amount' },
  { field: 'payee', header: 'Payee' },
  { field: 'void_flag', header: 'Void' },
];

const GENERIC_CSV: PositivePayConfig = {
  kind: 'csv',
  columns: CSV_COLUMNS,
  dateFormat: 'MM/DD/YYYY',
  amountFormat: 'decimal',
  delimiter: ',',
  header: true,
  quoteAll: false,
  issueFlag: '',
  voidFlag: 'V',
  actionIssue: 'IS',
  actionVoid: 'CN',
  uppercasePayee: false,
  lineEnding: '\r\n',
};

const GENERIC_FIXED: PositivePayConfig = {
  kind: 'fixed',
  columns: [
    { field: 'account_number', width: 12 },
    { field: 'check_number', width: 10 },
    { field: 'amount', width: 12 },
    { field: 'issue_date', width: 8 },
    { field: 'payee', width: 40 },
    { field: 'void_flag', width: 1 },
  ],
  dateFormat: 'MMDDYYYY',
  amountFormat: 'implied_decimal',
  delimiter: ',',
  header: false,
  quoteAll: false,
  issueFlag: ' ',
  voidFlag: 'V',
  actionIssue: 'IS',
  actionVoid: 'CN',
  payeeMaxLength: 40,
  uppercasePayee: false,
  lineEnding: '\r\n',
};

const US_BANK: PositivePayConfig = {
  ...GENERIC_FIXED,
  columns: [
    { field: 'account_number', width: 12 },
    { field: 'check_number', width: 10 },
    { field: 'amount', width: 12 },
    { field: 'issue_date', width: 8 },
    { field: 'action_code', width: 2 },
    { field: 'payee', width: 40 },
    { field: 'blank', width: 40 },
  ],
  uppercasePayee: false,
};

const PRESETS: Record<PositivePayFormatId, PositivePayConfig> = {
  generic_csv: GENERIC_CSV,
  generic_fixed: GENERIC_FIXED,
  bofa: GENERIC_CSV,
  chase: GENERIC_CSV,
  wells_fargo: GENERIC_CSV,
  us_bank: US_BANK,
};

/** A format's configuration with a bank account's overrides applied. */
export function getPositivePayConfig(format: PositivePayFormatId, overrides: Partial<PositivePayConfig> = {}): PositivePayConfig {
  const preset = PRESETS[format];
  return { ...preset, columns: preset.columns.map((column) => ({ ...column })), ...overrides };
}

export interface PositivePayCheck {
  checkNumber: string | number;
  /** `YYYY-MM-DD`. */
  issueDate: string;
  /** Dollars. */
  amount: number;
  payee: string;
  status: 'issued' | 'voided';
  /** `YYYY-MM-DD`; a voided check without one is treated as voided on its issue date. */
  voidDate?: string | null;
  /** For a file that covers several accounts; defaults to the file's account. */
  accountNumber?: string;
}

export interface PositivePayOptions {
  format: PositivePayFormatId;
  /** The bank account the checks are drawn on. */
  accountNumber: string;
  /** First and last day of the range, inclusive; either end may be left open. */
  from?: string;
  to?: string;
  config?: Partial<PositivePayConfig>;
}

export type PositivePayIssueCode =
  | 'no_checks'
  | 'invalid_check_number'
  | 'check_number_too_long'
  | 'invalid_account_number'
  | 'account_number_too_long'
  | 'invalid_amount'
  | 'invalid_date'
  | 'invalid_range'
  | 'missing_payee'
  | 'payee_trimmed'
  | 'duplicate_check_number'
  | 'missing_width';

export interface PositivePayIssue {
  severity: 'error' | 'warning';
  code: PositivePayIssueCode;
  message: string;
  checkNumber?: string;
}

export interface PositivePaySuccess {
  ok: true;
  content: string;
  fileName: string;
  format: PositivePayFormatId;
  recordCount: number;
  issueCount: number;
  voidCount: number;
  totalIssuedCents: number;
  totalVoidedCents: number;
  warnings: PositivePayIssue[];
}

export interface PositivePayFailure {
  ok: false;
  errors: PositivePayIssue[];
  warnings: PositivePayIssue[];
}

export type PositivePayResult = PositivePaySuccess | PositivePayFailure;

export function formatPositivePayDate(date: string, format: PositivePayDateFormat): string {
  const { y, m, d } = parseIso(date);
  const yyyy = String(y).padStart(4, '0');
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const yy = yyyy.slice(2);
  switch (format) {
    case 'MMDDYYYY':
      return `${mm}${dd}${yyyy}`;
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy}`;
    case 'YYYYMMDD':
      return `${yyyy}${mm}${dd}`;
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`;
    case 'MMDDYY':
      return `${mm}${dd}${yy}`;
    case 'MM/DD/YY':
      return `${mm}/${dd}/${yy}`;
  }
}

function formatAmount(cents: number, format: PositivePayAmountFormat): string {
  if (format === 'implied_decimal') return String(cents);
  const dollars = Math.floor(cents / 100);
  return `${dollars}.${String(cents % 100).padStart(2, '0')}`;
}

function csvCell(value: string, config: PositivePayConfig): string {
  const needsQuotes = config.quoteAll || value.includes(config.delimiter) || /["\r\n]/.test(value);
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

const NUMERIC_FIELDS = new Set<PositivePayField>(['account_number', 'check_number', 'amount']);

function fixedCell(value: string, column: PositivePayColumn): string {
  const width = column.width ?? 0;
  const numeric = NUMERIC_FIELDS.has(column.field);
  const align = column.align ?? (numeric ? 'right' : 'left');
  const pad = column.pad ?? (numeric ? '0' : ' ');
  const clipped = value.length > width ? value.slice(0, width) : value;
  return align === 'right' ? clipped.padStart(width, pad) : clipped.padEnd(width, pad);
}

interface Entry {
  check: PositivePayCheck;
  checkNumber: string;
  cents: number;
  voided: boolean;
}

function compareCheckNumbers(a: string, b: string): number {
  return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
}

/**
 * Builds the issue file for a date range. Returns every problem found
 * (a check number that is not digits, an amount with more than two decimals,
 * a value too wide for a fixed column) instead of a file when there is an
 * error; a payee that had to be shortened is a warning.
 */
export function buildPositivePayFile(checks: readonly PositivePayCheck[], options: PositivePayOptions): PositivePayResult {
  const config = getPositivePayConfig(options.format, options.config);
  const errors: PositivePayIssue[] = [];
  const warnings: PositivePayIssue[] = [];
  const issue = (list: PositivePayIssue[], severity: 'error' | 'warning', code: PositivePayIssueCode, message: string, checkNumber?: string) => {
    list.push(checkNumber === undefined ? { severity, code, message } : { severity, code, message, checkNumber });
  };

  const { from, to } = options;
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) issue(errors, 'error', 'invalid_range', 'The date range must be YYYY-MM-DD');
  else if (from && to && to < from) issue(errors, 'error', 'invalid_range', 'The range ends before it starts');

  if (config.kind === 'fixed') {
    for (const column of config.columns) {
      if (!column.width || column.width < 1) issue(errors, 'error', 'missing_width', `Fixed column ${column.field} needs a width`);
    }
  }

  const inRange = (date: string): boolean => (!from || date >= from) && (!to || date <= to);
  const records: Entry[] = [];
  const seen = new Set<string>();

  for (const check of checks) {
    const checkNumber = String(check.checkNumber).trim();
    const label = checkNumber || undefined;
    if (!isIsoDate(check.issueDate) || (check.voidDate != null && !isIsoDate(check.voidDate))) {
      issue(errors, 'error', 'invalid_date', 'Dates must be YYYY-MM-DD', label);
      continue;
    }
    const voidDate = check.status === 'voided' ? (check.voidDate ?? check.issueDate) : null;
    const issuedInRange = inRange(check.issueDate);
    const voidedInRange = voidDate !== null && inRange(voidDate);
    if (!issuedInRange && !voidedInRange) continue;

    if (!/^\d+$/.test(checkNumber)) {
      issue(errors, 'error', 'invalid_check_number', 'A check number is digits only', label);
      continue;
    }
    const cents = Math.round(check.amount * 100);
    if (!Number.isFinite(check.amount) || check.amount <= 0 || Math.abs(check.amount * 100 - cents) > 1e-6) {
      issue(errors, 'error', 'invalid_amount', 'The amount must be greater than zero with at most two decimals', label);
      continue;
    }
    if (seen.has(checkNumber + (check.accountNumber ?? ''))) issue(errors, 'error', 'duplicate_check_number', `Check ${checkNumber} appears twice`, label);
    seen.add(checkNumber + (check.accountNumber ?? ''));

    // A check voided by the end of the range is marked void, whatever the range started with.
    const voided = voidDate !== null && (!to || voidDate <= to);
    records.push({ check, checkNumber, cents, voided });
  }

  if (errors.length === 0 && records.length === 0) issue(errors, 'error', 'no_checks', 'No checks were issued or voided in this range');

  records.sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber));

  const lines: string[] = [];
  if (config.kind === 'csv' && config.header) {
    lines.push(config.columns.map((column) => csvCell(column.header ?? column.field, config)).join(config.delimiter));
  }

  const widthOf = (field: PositivePayField): number | undefined => config.columns.find((c) => c.field === field)?.width;

  for (const record of records) {
    const { check, checkNumber } = record;
    const account = (check.accountNumber ?? options.accountNumber).replace(/\s/g, '');
    if (!/^[0-9A-Za-z-]+$/.test(account)) {
      issue(errors, 'error', 'invalid_account_number', 'The account number is digits, letters and hyphens only', checkNumber);
      continue;
    }
    if (config.kind === 'fixed') {
      const accountWidth = widthOf('account_number');
      if (accountWidth !== undefined && account.length > accountWidth) {
        issue(errors, 'error', 'account_number_too_long', `The account number is wider than the ${accountWidth}-character column`, checkNumber);
        continue;
      }
      const checkWidth = widthOf('check_number');
      if (checkWidth !== undefined && checkNumber.length > checkWidth) {
        issue(errors, 'error', 'check_number_too_long', `Check ${checkNumber} is wider than the ${checkWidth}-character column`, checkNumber);
        continue;
      }
    }

    let payee = check.payee.replace(/[\r\n]+/g, ' ').trim();
    if (config.uppercasePayee) payee = payee.toUpperCase();
    if (!payee) issue(warnings, 'warning', 'missing_payee', 'The check has no payee name', checkNumber);
    const payeeLimit = config.payeeMaxLength ?? (config.kind === 'fixed' ? widthOf('payee') : undefined);
    if (payeeLimit !== undefined && payee.length > payeeLimit) {
      issue(warnings, 'warning', 'payee_trimmed', `The payee is longer than ${payeeLimit} characters and was cut`, checkNumber);
      payee = payee.slice(0, payeeLimit).trimEnd();
    }

    const voidDate = check.status === 'voided' ? (check.voidDate ?? check.issueDate) : null;
    const value = (column: PositivePayColumn): string => {
      switch (column.field) {
        case 'account_number':
          return account;
        case 'check_number':
          return checkNumber;
        case 'issue_date':
          return formatPositivePayDate(check.issueDate, config.dateFormat);
        case 'amount':
          return formatAmount(record.cents, config.amountFormat);
        case 'payee':
          return payee;
        case 'void_flag':
          return record.voided ? config.voidFlag : config.issueFlag;
        case 'void_date':
          return record.voided && voidDate ? formatPositivePayDate(voidDate, config.dateFormat) : '';
        case 'action_code':
          return record.voided ? config.actionVoid : config.actionIssue;
        case 'blank':
          return column.literal ?? '';
      }
    };

    if (config.kind === 'fixed') {
      lines.push(config.columns.map((column) => fixedCell(value(column), column)).join(''));
    } else {
      lines.push(config.columns.map((column) => csvCell(value(column), config)).join(config.delimiter));
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const voids = records.filter((record) => record.voided);
  const issued = records.filter((record) => !record.voided);
  const last = options.to ?? records.reduce((latest, r) => (r.check.issueDate > latest ? r.check.issueDate : latest), '0000-00-00');
  const accountTail = options.accountNumber.replace(/\W/g, '').slice(-4);
  const extension = config.kind === 'csv' ? 'csv' : 'txt';
  return {
    ok: true,
    content: lines.join(config.lineEnding) + config.lineEnding,
    fileName: `positive-pay-${accountTail || 'account'}-${isIsoDate(last) ? last : 'file'}.${extension}`,
    format: options.format,
    recordCount: records.length,
    issueCount: issued.length,
    voidCount: voids.length,
    totalIssuedCents: issued.reduce((sum, r) => sum + r.cents, 0),
    totalVoidedCents: voids.reduce((sum, r) => sum + r.cents, 0),
    warnings,
  };
}
