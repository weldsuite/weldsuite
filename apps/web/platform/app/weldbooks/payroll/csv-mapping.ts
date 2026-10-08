/**
 * The payroll CSV import without the React: reading the file's header and
 * rows (enough to offer the columns and the account labels), guessing which
 * column means what, the mapping the import sends, and the verdict on a dry
 * run. The server parses and validates the whole file again; nothing here is
 * trusted by it.
 */
import {
  PAYROLL_CATEGORY_KEYS,
  type AccountMapping,
  type CsvDateFormat,
  type CsvImportResult,
  type CsvMapping,
  type GlColumns,
  type ImportedPayroll,
  type PayrollCategoryKey,
  type SummaryColumns,
} from '@/lib/api/domains/weldbooks-assets';
import { toCents } from '../fixed-assets/asset-math';

// ---------------------------------------------------------------------------
// Reading the file

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

const DELIMITERS = [',', ';', '\t'] as const;

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best: string = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const char of firstLine) {
      if (char === '"') quoted = !quoted;
      else if (char === delimiter && !quoted) count += 1;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180 reading as the server does it: quoted fields, doubled quotes, CRLF, a BOM, comma, semicolon or tab separated. */
export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((row) => row.some((value) => value.trim() !== ''));
  const [headers = [], ...rows] = nonEmpty;
  return { headers: headers.map((header) => header.trim()), rows };
}

/** The distinct values of a column (trimmed, in file order), for the labels of a general-ledger export. */
export function distinctValues(parsed: ParsedCsv, column: string | undefined): string[] {
  if (!column) return [];
  const index = parsed.headers.findIndex((header) => header.toLowerCase() === column.trim().toLowerCase());
  if (index < 0) return [];
  const seen = new Set<string>();
  for (const row of parsed.rows) {
    const value = (row[index] ?? '').trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Which column means what

export const SUMMARY_COLUMN_FIELDS: ReadonlyArray<{ key: keyof SummaryColumns; required: boolean }> = [
  { key: 'payDate', required: true },
  { key: 'grossWages', required: true },
  { key: 'netPay', required: true },
  { key: 'employerTaxes', required: false },
  { key: 'employeeTaxes', required: false },
  { key: 'employeeDeductions', required: false },
  { key: 'employerBenefits', required: false },
  { key: 'reimbursements', required: false },
  { key: 'ownersDraw', required: false },
  { key: 'periodStart', required: false },
  { key: 'periodEnd', required: false },
  { key: 'reference', required: false },
];

export const GL_COLUMN_FIELDS: ReadonlyArray<{ key: keyof GlColumns; required: boolean }> = [
  { key: 'date', required: true },
  { key: 'account', required: true },
  { key: 'debit', required: true },
  { key: 'credit', required: true },
  { key: 'memo', required: false },
];

type Guess = ReadonlyArray<readonly [string, RegExp]>;

/** Most specific first: a header is given to the first field it fits, and each header is used once. */
const SUMMARY_GUESSES: Guess = [
  ['periodStart', /period\s*start|start\s*date|pay\s*period\s*(from|begin)/i],
  ['periodEnd', /period\s*end|end\s*date|pay\s*period\s*(to|end)/i],
  ['employerBenefits', /employer.*(benefit|contribution|401|retirement)|benefit.*employer/i],
  ['employerTaxes', /employer.*tax|company.*tax|er\s*tax/i],
  ['employeeTaxes', /employee.*tax|tax(es)?\s*(withheld|withholding)|withheld|ee\s*tax/i],
  ['employeeDeductions', /deduction|garnish/i],
  ['reimbursements', /reimburs/i],
  ['ownersDraw', /owner|draw|distribution/i],
  ['grossWages', /gross/i],
  ['netPay', /net\s*(pay|wages)?|take\s*home|check\s*amount/i],
  ['payDate', /pay\s*date|check\s*date|payday|date/i],
  ['reference', /reference|payroll\s*(id|name|number|run)|run\s*(id|name)|batch/i],
];

const GL_GUESSES: Guess = [
  ['debit', /debit|\bdr\b/i],
  ['credit', /credit|\bcr\b/i],
  ['account', /account|acct|category|\bgl\b/i],
  ['memo', /memo|description|note|detail/i],
  ['date', /date/i],
];

function guessColumns(headers: readonly string[], guesses: Guess): Record<string, string> {
  const used = new Set<number>();
  const result: Record<string, string> = {};
  for (const [key, pattern] of guesses) {
    const index = headers.findIndex((header, position) => !used.has(position) && pattern.test(header));
    if (index >= 0) {
      used.add(index);
      result[key] = headers[index] as string;
    }
  }
  return result;
}

export const guessSummaryColumns = (headers: readonly string[]): MappingDraft['summaryColumns'] =>
  guessColumns(headers, SUMMARY_GUESSES) as MappingDraft['summaryColumns'];

export const guessGlColumns = (headers: readonly string[]): MappingDraft['glColumns'] =>
  guessColumns(headers, GL_GUESSES) as MappingDraft['glColumns'];

/**
 * `dmy` when a date in the column cannot be month first (its first part is
 * over 12); otherwise `auto`, which reads slash dates month first and ISO
 * dates as they are.
 */
export function guessDateFormat(parsed: ParsedCsv, column: string | undefined): CsvDateFormat {
  if (!column) return 'auto';
  const index = parsed.headers.findIndex((header) => header.toLowerCase() === column.trim().toLowerCase());
  if (index < 0) return 'auto';
  for (const row of parsed.rows) {
    const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec((row[index] ?? '').trim());
    if (match && Number(match[1]) > 12) return 'dmy';
  }
  return 'auto';
}

// ---------------------------------------------------------------------------
// The mapping the wizard builds

export interface MappingDraft {
  shape: 'summary' | 'gl';
  dateFormat: CsvDateFormat;
  summaryColumns: Partial<Record<keyof SummaryColumns, string>>;
  glColumns: Partial<Record<keyof GlColumns, string>>;
  /** Payroll category to account id (summary shape). */
  summaryAccounts: AccountMapping;
  /** The export's account label to an account id (general-ledger shape). */
  glAccounts: Record<string, string>;
}

export function emptyDraft(): MappingDraft {
  return { shape: 'summary', dateFormat: 'auto', summaryColumns: {}, glColumns: {}, summaryAccounts: {}, glAccounts: {} };
}

const hasHeader = (headers: readonly string[], name: string | undefined): boolean =>
  !!name && headers.some((header) => header.trim().toLowerCase() === name.trim().toLowerCase());

/** A first draft from the file alone: the shape its headers suggest, the columns they fit, the date format its dates need. */
export function draftFromFile(parsed: ParsedCsv): MappingDraft {
  const headers = parsed.headers;
  const glColumns = guessGlColumns(headers);
  const looksLikeLedger = Boolean(glColumns.debit && glColumns.credit && glColumns.account);
  const summaryColumns = guessSummaryColumns(headers);
  return {
    ...emptyDraft(),
    shape: looksLikeLedger ? 'gl' : 'summary',
    summaryColumns,
    glColumns,
    dateFormat: guessDateFormat(parsed, looksLikeLedger ? glColumns.date : summaryColumns.payDate),
  };
}

/** The entity's saved mapping as a draft, when every column it names exists in this file; otherwise null. */
export function draftFromSaved(saved: CsvMapping, parsed: ParsedCsv): MappingDraft | null {
  const columns = Object.values(saved.columns).filter((value): value is string => typeof value === 'string');
  if (!columns.every((name) => hasHeader(parsed.headers, name))) return null;
  const draft = emptyDraft();
  draft.shape = saved.shape;
  draft.dateFormat = saved.dateFormat;
  if (saved.shape === 'summary') {
    draft.summaryColumns = { ...saved.columns };
    draft.summaryAccounts = { ...saved.accounts };
  } else {
    draft.glColumns = { ...saved.columns };
    draft.glAccounts = { ...saved.accounts };
  }
  return draft;
}

/** The required columns the draft has not mapped yet. */
export function missingColumns(draft: MappingDraft): string[] {
  const fields = draft.shape === 'summary' ? SUMMARY_COLUMN_FIELDS : GL_COLUMN_FIELDS;
  const chosen: Record<string, string | undefined> = draft.shape === 'summary' ? draft.summaryColumns : draft.glColumns;
  return fields.filter((field) => field.required && !chosen[field.key]).map((field) => field.key);
}

/** The account a summary payroll cannot be posted without: where the net pay came from. */
export function missingAccounts(draft: MappingDraft): PayrollCategoryKey[] {
  return draft.shape === 'summary' && !draft.summaryAccounts.net_pay ? ['net_pay'] : [];
}

/**
 * The mapping the import sends: only the columns that were chosen and the
 * accounts that were set. Null while a required column is missing.
 */
export function buildCsvMapping(draft: MappingDraft): CsvMapping | null {
  if (missingColumns(draft).length > 0) return null;
  if (draft.shape === 'summary') {
    const columns: Record<string, string> = {};
    for (const field of SUMMARY_COLUMN_FIELDS) {
      const value = draft.summaryColumns[field.key];
      if (value) columns[field.key] = value;
    }
    const accounts: AccountMapping = {};
    for (const key of PAYROLL_CATEGORY_KEYS) {
      const value = draft.summaryAccounts[key];
      if (value) accounts[key] = value;
    }
    return { shape: 'summary', columns: columns as unknown as SummaryColumns, accounts, dateFormat: draft.dateFormat };
  }
  const columns: Record<string, string> = {};
  for (const field of GL_COLUMN_FIELDS) {
    const value = draft.glColumns[field.key];
    if (value) columns[field.key] = value;
  }
  const accounts: Record<string, string> = {};
  for (const [label, accountId] of Object.entries(draft.glAccounts)) {
    if (accountId) accounts[label] = accountId;
  }
  return { shape: 'gl', columns: columns as unknown as GlColumns, accounts, dateFormat: draft.dateFormat };
}

// ---------------------------------------------------------------------------
// The dry run

/** Debits and credits of an imported payroll in whole cents, and whether they agree. */
export function payrollBalance(payroll: Pick<ImportedPayroll, 'lines'>): { debit: number; credit: number; balanced: boolean } {
  let debit = 0;
  let credit = 0;
  for (const line of payroll.lines) {
    debit += toCents(line.debit);
    credit += toCents(line.credit);
  }
  return { debit: debit / 100, credit: credit / 100, balanced: debit === credit };
}

export interface DryRunVerdict {
  /** Pay dates whose entry does not balance. */
  unbalanced: string[];
  /** Payrolls the import would post. */
  toPost: number;
  /** Payrolls that could not be built (the same payroll twice in the file, say). */
  failed: number;
  /** Nothing is wrong and something would be posted. */
  canImport: boolean;
}

/** Whether a dry run may be imported: every entry balances, none failed, and at least one payroll would post. */
export function judgeDryRun(result: Pick<CsvImportResult, 'imports' | 'failed'> | null | undefined): DryRunVerdict {
  if (!result) return { unbalanced: [], toPost: 0, failed: 0, canImport: false };
  const unbalanced = result.imports.filter((payroll) => !payrollBalance(payroll).balanced).map((payroll) => payroll.payDate);
  return {
    unbalanced,
    toPost: result.imports.length,
    failed: result.failed.length,
    canImport: unbalanced.length === 0 && result.failed.length === 0 && result.imports.length > 0,
  };
}
