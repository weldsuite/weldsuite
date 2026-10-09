/**
 * NACHA ACH file builder for vendor payment runs (credits to vendors' bank
 * accounts), plus a verifier that re-reads a file and checks its layout.
 *
 * Layout (docs/plans/weldbooks-us-research/federal.md section 9, Nacha ACH
 * file details): 94-character records, blocking factor 10 (the file is padded
 * with all-9 records to a multiple of 10 lines).
 *
 *   1 File Header, 5 Batch Header, 6 Entry Detail, 7 Addenda (type 05),
 *   8 Batch Control, 9 File Control.
 *
 * Choices made here, to be matched to the originating bank's own guide:
 * - One batch per SEC header code (PPD, CCD, CTX). CCD+ is a CCD entry with
 *   one 05 addenda record and shares the CCD batch.
 * - Trace numbers are the ODFI's 8 digits plus a 7-digit sequence that keeps
 *   counting across the batches of one file.
 * - Service class 220 (credits only) for an unbalanced file. A balanced file
 *   adds one offsetting debit (27 checking, 37 savings) to the originator's
 *   account per batch, which makes the batch 200 (mixed).
 * - Same Day ACH is requested the way the Nacha rules describe: the effective
 *   entry date is the file's own date and the Company Descriptive Date holds
 *   `SDHHMM`, the settlement time asked for. A standard file carries a later
 *   effective date and a blank (or caller supplied) descriptive date.
 * - Prenotes (23 checking, 33 savings) are zero-dollar entries without
 *   addenda.
 * - The entry description "PAYROLL" is reserved for PPD wage credits and
 *   "PURCHASE" for online consumer debits (Nacha rules in force since 20 March
 *   2026), so neither can describe a vendor payment run.
 *
 * Positive Pay does not satisfy Nacha's 2026 fraud-monitoring rule; dual
 * approval and the bank-detail-change hold live in the payment run flow, not
 * in this pure file builder.
 */

import { addDays, formatIso, lastWeekdayOfMonth, nthWeekdayOfMonth, parseIso, weekdayOf, isIsoDate } from './dates';

export type NachaSecCode = 'PPD' | 'CCD' | 'CCD+' | 'CTX';
/** The SEC code a batch header carries (CCD+ is CCD). */
export type NachaBatchSecCode = 'PPD' | 'CCD' | 'CTX';
export type NachaAccountType = 'checking' | 'savings';
export type NachaServiceClass = 200 | 220 | 225;

export const NACHA_RECORD_LENGTH = 94;
export const NACHA_BLOCKING_FACTOR = 10;
/** Largest amount of one entry: 10 digits of cents. */
export const NACHA_MAX_AMOUNT_CENTS = 9_999_999_999;
export const NACHA_MAX_AMOUNT = NACHA_MAX_AMOUNT_CENTS / 100;
/** Addenda records one CTX entry can carry (a 4-digit count). */
export const NACHA_MAX_CTX_ADDENDA = 9_999;
export const NACHA_ADDENDA_TEXT_LENGTH = 80;

/**
 * The three Same Day ACH windows. Submission deadlines (ET) are the research's
 * "about 10:30, 2:45 and 4:45"; the settlement times come from Nacha's
 * published schedule and are not in the research. The research (federal.md
 * section 12, item 10) could not confirm whether a fourth window was adopted
 * for September 2026, so it is not encoded.
 */
export const SAME_DAY_ACH_WINDOWS = [
  { window: 1, submissionDeadlineEt: '1030', settlementEt: '1300' },
  { window: 2, submissionDeadlineEt: '1445', settlementEt: '1700' },
  { window: 3, submissionDeadlineEt: '1645', settlementEt: '1800' },
] as const;

/** Settlement time written to the descriptor when a same-day file does not name one. */
export const DEFAULT_SAME_DAY_SETTLEMENT = '1700';

/** Same Day ACH per-payment limit in dollars: $1M, rising to $10M on 17 September 2027 (federal.md section 9). */
export function sameDayLimitDollars(date: string): number {
  return date >= '2027-09-17' ? 10_000_000 : 1_000_000;
}

export type NachaIssueCode =
  | 'no_payments'
  | 'duplicate_payment_id'
  | 'invalid_routing_format'
  | 'invalid_routing_checksum'
  | 'invalid_account_number'
  | 'invalid_amount'
  | 'amount_exceeds_maximum'
  | 'same_day_limit_exceeded'
  | 'missing_name'
  | 'missing_payment_info'
  | 'too_many_addenda'
  | 'invalid_effective_date'
  | 'invalid_file_date'
  | 'invalid_file_time'
  | 'invalid_file_id_modifier'
  | 'invalid_company_identification'
  | 'invalid_immediate_origin'
  | 'invalid_same_day_time'
  | 'missing_offset_account'
  | 'reserved_entry_description'
  | 'invalid_sec_code'
  | 'file_too_large'
  | 'name_trimmed'
  | 'description_trimmed'
  | 'identification_trimmed'
  | 'text_sanitized'
  | 'addenda_trimmed'
  | 'addenda_ignored'
  | 'prenote_amount_ignored'
  | 'prenote_addenda_ignored'
  | 'effective_date_not_banking_day'
  | 'effective_date_not_after_file_date'
  | 'same_day_effective_date_mismatch'
  // Verifier findings.
  | 'record_length'
  | 'record_order'
  | 'record_count'
  | 'blocking'
  | 'control_total'
  | 'entry_hash'
  | 'trace_number'
  | 'transaction_code'
  | 'addenda_sequence'
  | 'invalid_character';

export interface NachaIssue {
  severity: 'error' | 'warning';
  code: NachaIssueCode;
  message: string;
  /** The payment the issue is about. */
  paymentId?: string;
  field?: string;
}

export interface NachaOriginator {
  /** The bank's 9-digit routing number the file is sent to (immediate destination). */
  immediateDestination: string;
  immediateDestinationName: string;
  /** The company's ID (10 characters, e.g. "1" + EIN) or its bank's 9-digit routing number. */
  immediateOrigin: string;
  immediateOriginName: string;
  /** Appears on the vendor's statement (16 characters). */
  companyName: string;
  /** 10 characters: an identifier code digit plus the ID, e.g. "1" + 9-digit EIN. A 9-digit EIN gets the "1". */
  companyIdentification: string;
  /** The originating bank's routing number; defaults to `immediateDestination`. Its first 8 digits go in every trace number. */
  odfiRoutingNumber?: string;
  /** Free text in the file header (8 characters). */
  referenceCode?: string;
  /** Free text in each batch header (20 characters). */
  companyDiscretionaryData?: string;
  /** The originator's own account, debited by the offsetting entry of a balanced file. */
  offsetAccount?: {
    routingNumber: string;
    accountNumber: string;
    accountType: NachaAccountType;
    /** Name on the offset entry; defaults to the company name. */
    name?: string;
    identification?: string;
  };
}

export interface NachaPayment {
  /** The caller's id (a payment or bill id), echoed in issues and the trace list. */
  id: string;
  /** Defaults to the file's `defaultSecCode`. */
  secCode?: NachaSecCode;
  /** Vendor name: 22 characters (16 for CTX). */
  name: string;
  routingNumber: string;
  accountNumber: string;
  accountType: NachaAccountType;
  /** Dollars. Ignored for a prenote. */
  amount: number;
  /** A zero-dollar test entry to verify the account. */
  prenote?: boolean;
  /** Printed with the entry: vendor or invoice number (15 characters). */
  identification?: string;
  /**
   * CCD+: the payment related information (80 characters). CTX: the remittance
   * (an X12 820, or RMR segments) of any length, split over addenda records.
   * PPD: optional single addenda.
   */
  paymentInfo?: string;
}

export interface NachaFileInput {
  originator: NachaOriginator;
  payments: readonly NachaPayment[];
  /** The date the money should arrive, `YYYY-MM-DD`. For same-day files it is the file date. */
  effectiveEntryDate: string;
  /** When the file is made. `time` is `HHMM` and optional. */
  fileCreation: { date: string; time?: string };
  /** A to Z or 0 to 9; change it for each file made on the same day. Default `A`. */
  fileIdModifier?: string;
  /** SEC code of payments that do not name one. Default `CCD`. */
  defaultSecCode?: NachaSecCode;
  /** Up to 10 characters. Default `VENDOR PAY`. */
  entryDescription?: string;
  /** Add an offsetting debit to the originator's account per batch. Default false (unbalanced). */
  balanced?: boolean;
  /** Ask for Same Day ACH; `settlementTime` is `HHMM` (ET). */
  sameDay?: boolean | { settlementTime: string };
  /** Company Descriptive Date of a standard file (6 characters), e.g. "OCT 15". */
  descriptiveDate?: string;
  startingBatchNumber?: number;
  startingTraceSequence?: number;
  /** Default `\r\n`. */
  lineEnding?: '\r\n' | '\n';
}

export interface NachaBatchSummary {
  batchNumber: number;
  secCode: NachaBatchSecCode;
  serviceClassCode: NachaServiceClass;
  /** Entry detail plus addenda records, as in the batch control. */
  entryAddendaCount: number;
  entryHash: string;
  totalDebitCents: number;
  totalCreditCents: number;
}

export interface NachaTrace {
  /** Null for an offsetting entry. */
  paymentId: string | null;
  kind: 'payment' | 'prenote' | 'offset';
  traceNumber: string;
  batchNumber: number;
}

export interface NachaBuildSuccess {
  ok: true;
  content: string;
  lines: string[];
  /** Lines including the padding records. */
  recordCount: number;
  blockCount: number;
  batchCount: number;
  entryAddendaCount: number;
  entryHash: string;
  totalDebitCents: number;
  totalCreditCents: number;
  batches: NachaBatchSummary[];
  traces: NachaTrace[];
  warnings: NachaIssue[];
}

export interface NachaBuildFailure {
  ok: false;
  errors: NachaIssue[];
  warnings: NachaIssue[];
}

export type NachaBuildResult = NachaBuildSuccess | NachaBuildFailure;

// ---------------------------------------------------------------------------
// Routing numbers, text and dates

const ABA_WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7, 1];

/** The ABA checksum: weights 3, 7, 1 repeating over the nine digits, sum divisible by 10. */
export function abaChecksumValid(routingNumber: string): boolean {
  if (!/^\d{9}$/.test(routingNumber)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(routingNumber[i]) * (ABA_WEIGHTS[i] as number);
  return sum % 10 === 0;
}

/** The ninth (check) digit that completes an 8-digit routing prefix. */
export function abaCheckDigit(firstEight: string): string {
  if (!/^\d{8}$/.test(firstEight)) throw new RangeError('A routing prefix is 8 digits');
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(firstEight[i]) * (ABA_WEIGHTS[i] as number);
  return String((10 - (sum % 10)) % 10);
}

/** "1" plus the 9-digit EIN: the Company Identification a business usually has. */
export function companyIdFromEin(ein: string): string {
  const digits = ein.replace(/\D/g, '');
  if (digits.length !== 9) throw new RangeError('An EIN is 9 digits');
  return `1${digits}`;
}

const ALLOWED_TEXT = /[^A-Z0-9 .,&'#()@\-/$%+:;?!]/g;

/**
 * Upper-case text with accents removed and anything outside the characters
 * every ODFI accepts (A-Z, 0-9, space and . , & ' # ( ) @ - / $ % + : ; ? !)
 * turned into a space.
 */
export function sanitizeAchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(ALLOWED_TEXT, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Addenda text keeps the X12 delimiters (* ~ \ > <) and any other printable ASCII. */
function sanitizeAddenda(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^\x20-\x7e]/g, ' ');
}

function yymmdd(date: string): string {
  const { y, m, d } = parseIso(date);
  return `${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

/** Federal Reserve holidays: a holiday on a Sunday closes the Monday; one on a Saturday closes nothing. */
function fedHolidays(year: number): Set<string> {
  const MON = 1;
  const THU = 4;
  const fixed = (m: number, d: number): string | null => {
    const date = formatIso(year, m, d);
    const weekday = weekdayOf(date);
    if (weekday === 6) return null;
    return weekday === 0 ? addDays(date, 1) : date;
  };
  const days = [
    fixed(1, 1),
    nthWeekdayOfMonth(year, 1, MON, 3),
    nthWeekdayOfMonth(year, 2, MON, 3),
    lastWeekdayOfMonth(year, 5, MON),
    fixed(6, 19),
    fixed(7, 4),
    nthWeekdayOfMonth(year, 9, MON, 1),
    nthWeekdayOfMonth(year, 10, MON, 2),
    fixed(11, 11),
    nthWeekdayOfMonth(year, 11, THU, 4),
    fixed(12, 25),
  ];
  return new Set(days.filter((d): d is string => d !== null));
}

/** A day the ACH operator settles: a weekday that is not a Federal Reserve holiday. */
export function isAchBankingDay(date: string): boolean {
  const weekday = weekdayOf(date);
  if (weekday === 0 || weekday === 6) return false;
  const year = parseIso(date).y;
  return !fedHolidays(year).has(date) && !fedHolidays(year + 1).has(date);
}

/** The date itself when it is a banking day, otherwise the next one. */
export function nextAchBankingDay(date: string): string {
  let current = date;
  while (!isAchBankingDay(current)) current = addDays(current, 1);
  return current;
}

/**
 * The effective entry date to write: the file's own date for Same Day ACH,
 * otherwise the requested date, but never earlier than the next banking day
 * after the file is made.
 */
export function suggestEffectiveEntryDate(requested: string, fileDate: string, sameDay = false): string {
  if (sameDay) return nextAchBankingDay(fileDate);
  const earliest = nextAchBankingDay(addDays(fileDate, 1));
  return nextAchBankingDay(requested < earliest ? earliest : requested);
}

/**
 * Remittance segments for a CCD+ or CTX addenda: one X12 RMR segment per
 * invoice ("RMR*IV*INV-1042**1250.00\"), joined with the backslash segment
 * terminator ACH addenda use.
 */
export function buildRmrSegments(items: ReadonlyArray<{ reference: string; amount: number }>, terminator = '\\'): string {
  return items
    .map((item) => `RMR*IV*${item.reference.replace(/[*\\~]/g, ' ').trim()}**${item.amount.toFixed(2)}${terminator}`)
    .join('');
}

// ---------------------------------------------------------------------------
// Field formatting

function alpha(value: string, length: number): string {
  return value.length >= length ? value.slice(0, length) : value.padEnd(length, ' ');
}

function numeric(value: number, length: number): string {
  const text = String(value);
  if (text.length > length) throw new RangeError(`${value} does not fit in ${length} digits`);
  return text.padStart(length, '0');
}

function hashOf(rdfiIds: readonly string[]): number {
  let sum = 0;
  for (const id of rdfiIds) sum += Number(id);
  return sum % 10_000_000_000;
}

function assertLine(line: string): string {
  if (line.length !== NACHA_RECORD_LENGTH) throw new Error(`NACHA record is ${line.length} characters: ${line}`);
  return line;
}

const TRANSACTION_CODES = {
  checking: { credit: '22', prenote: '23', debit: '27' },
  savings: { credit: '32', prenote: '33', debit: '37' },
} as const;

const RESERVED_DESCRIPTIONS = new Set(['PAYROLL', 'PURCHASE']);

function batchSecOf(sec: NachaSecCode): NachaBatchSecCode {
  return sec === 'CCD+' ? 'CCD' : sec;
}

interface PreparedEntry {
  kind: 'payment' | 'prenote' | 'offset';
  paymentId: string | null;
  secHeader: NachaBatchSecCode;
  transactionCode: string;
  rdfi: string;
  checkDigit: string;
  account: string;
  cents: number;
  identification: string;
  name: string;
  addenda: string[];
}

class Collector {
  readonly errors: NachaIssue[] = [];
  readonly warnings: NachaIssue[] = [];

  error(code: NachaIssueCode, message: string, extra: Pick<NachaIssue, 'paymentId' | 'field'> = {}): void {
    this.errors.push({ severity: 'error', code, message, ...extra });
  }

  warn(code: NachaIssueCode, message: string, extra: Pick<NachaIssue, 'paymentId' | 'field'> = {}): void {
    this.warnings.push({ severity: 'warning', code, message, ...extra });
  }
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Sanitizes and trims a text field, recording what changed. */
function textField(
  raw: string,
  length: number,
  issues: Collector,
  field: string,
  trimCode: NachaIssueCode,
  paymentId?: string,
): string {
  const clean = sanitizeAchText(raw);
  const extra = { field, paymentId };
  // Accents and case are normalised silently; anything else that had to go is worth a warning.
  if (/[^A-Za-z0-9 .,&'#()@\-/$%+:;?!]/.test(stripAccents(raw))) {
    issues.warn('text_sanitized', `${field} had characters ACH does not allow; they were replaced with spaces`, extra);
  }
  if (clean.length > length) {
    issues.warn(trimCode, `${field} is longer than ${length} characters and was trimmed`, extra);
    return clean.slice(0, length).trimEnd();
  }
  return clean;
}

function validRouting(value: string, issues: Collector, field: string, paymentId?: string): boolean {
  const extra = { field, paymentId };
  if (!/^\d{9}$/.test(value)) {
    issues.error('invalid_routing_format', `${field} must be 9 digits`, extra);
    return false;
  }
  if (!abaChecksumValid(value)) {
    issues.error('invalid_routing_checksum', `${field} ${value} fails the ABA checksum`, extra);
    return false;
  }
  return true;
}

function cleanAccount(value: string): string | null {
  const account = value.replace(/\s/g, '').toUpperCase();
  return /^[A-Z0-9-]{1,17}$/.test(account) ? account : null;
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3])[0-5]\d$/.test(value);
}

/** Splits text into the 80-character pieces addenda records carry. */
function chunkAddenda(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += NACHA_ADDENDA_TEXT_LENGTH) chunks.push(text.slice(i, i + NACHA_ADDENDA_TEXT_LENGTH));
  return chunks;
}

function prepareEntries(input: NachaFileInput, issues: Collector, fileDate: string): PreparedEntry[] {
  const defaultSec = input.defaultSecCode ?? 'CCD';
  const sameDayLimit = sameDayLimitDollars(fileDate);
  const sameDay = Boolean(input.sameDay);
  const entries: PreparedEntry[] = [];
  const seen = new Set<string>();

  for (const payment of input.payments) {
    const id = payment.id;
    if (seen.has(id)) issues.error('duplicate_payment_id', `Payment id ${id} appears twice`, { paymentId: id });
    seen.add(id);

    const sec = payment.secCode ?? defaultSec;
    if (!['PPD', 'CCD', 'CCD+', 'CTX'].includes(sec)) {
      issues.error('invalid_sec_code', `Unsupported SEC code ${String(sec)}`, { paymentId: id, field: 'secCode' });
      continue;
    }
    const prenote = Boolean(payment.prenote);

    const routingOk = validRouting(payment.routingNumber, issues, 'routingNumber', id);
    const account = cleanAccount(payment.accountNumber);
    if (!account) {
      issues.error('invalid_account_number', 'The account number must be 1 to 17 letters, digits or hyphens', { paymentId: id, field: 'accountNumber' });
    }

    let cents = 0;
    if (prenote) {
      if (payment.amount !== 0 && payment.amount !== undefined) {
        issues.warn('prenote_amount_ignored', 'A prenote carries no amount; it was written as $0.00', { paymentId: id, field: 'amount' });
      }
    } else if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
      issues.error('invalid_amount', 'The amount must be greater than zero', { paymentId: id, field: 'amount' });
    } else {
      cents = Math.round(payment.amount * 100);
      if (Math.abs(payment.amount * 100 - cents) > 1e-6) {
        issues.error('invalid_amount', 'The amount has more than two decimals', { paymentId: id, field: 'amount' });
      } else if (cents > NACHA_MAX_AMOUNT_CENTS) {
        issues.error('amount_exceeds_maximum', `The amount is more than ${NACHA_MAX_AMOUNT.toLocaleString('en-US')}`, { paymentId: id, field: 'amount' });
      } else if (sameDay && payment.amount > sameDayLimit) {
        issues.error('same_day_limit_exceeded', `Same Day ACH is limited to ${sameDayLimit.toLocaleString('en-US')} a payment`, { paymentId: id, field: 'amount' });
      }
    }

    const nameLength = sec === 'CTX' ? 16 : 22;
    const name = textField(payment.name ?? '', nameLength, issues, 'name', 'name_trimmed', id);
    if (!name) issues.error('missing_name', 'The vendor name is required', { paymentId: id, field: 'name' });

    const identification = textField(payment.identification ?? '', 15, issues, 'identification', 'identification_trimmed', id);

    const addenda: string[] = [];
    const info = payment.paymentInfo?.trim() ? sanitizeAddenda(payment.paymentInfo.trim()) : '';
    if (prenote) {
      if (info) issues.warn('prenote_addenda_ignored', 'A prenote carries no addenda', { paymentId: id, field: 'paymentInfo' });
    } else if (sec === 'CCD+') {
      if (!info) {
        issues.error('missing_payment_info', 'CCD+ needs payment related information for its addenda record', { paymentId: id, field: 'paymentInfo' });
      } else {
        if (info.length > NACHA_ADDENDA_TEXT_LENGTH) {
          issues.warn('addenda_trimmed', `CCD+ carries one addenda of ${NACHA_ADDENDA_TEXT_LENGTH} characters; the rest was cut`, { paymentId: id, field: 'paymentInfo' });
        }
        addenda.push(info.slice(0, NACHA_ADDENDA_TEXT_LENGTH));
      }
    } else if (sec === 'CTX') {
      const chunks = chunkAddenda(info);
      if (chunks.length > NACHA_MAX_CTX_ADDENDA) {
        issues.error('too_many_addenda', `A CTX entry carries at most ${NACHA_MAX_CTX_ADDENDA} addenda records`, { paymentId: id, field: 'paymentInfo' });
      }
      addenda.push(...chunks);
    } else if (sec === 'PPD' && info) {
      if (info.length > NACHA_ADDENDA_TEXT_LENGTH) {
        issues.warn('addenda_trimmed', `PPD carries one addenda of ${NACHA_ADDENDA_TEXT_LENGTH} characters; the rest was cut`, { paymentId: id, field: 'paymentInfo' });
      }
      addenda.push(info.slice(0, NACHA_ADDENDA_TEXT_LENGTH));
    } else if (sec === 'CCD' && info) {
      issues.warn('addenda_ignored', 'CCD carries no addenda; use CCD+ to send payment information', { paymentId: id, field: 'paymentInfo' });
    }

    if (!routingOk || !account) continue;
    const codes = TRANSACTION_CODES[payment.accountType === 'savings' ? 'savings' : 'checking'];
    entries.push({
      kind: prenote ? 'prenote' : 'payment',
      paymentId: id,
      secHeader: batchSecOf(sec),
      transactionCode: prenote ? codes.prenote : codes.credit,
      rdfi: payment.routingNumber.slice(0, 8),
      checkDigit: payment.routingNumber.slice(8, 9),
      account,
      cents,
      identification,
      name,
      addenda,
    });
  }
  return entries;
}

const BATCH_ORDER: readonly NachaBatchSecCode[] = ['PPD', 'CCD', 'CTX'];

/**
 * Builds a NACHA file. Any error (a routing number that fails its checksum,
 * an amount over $99,999,999.99, ...) returns `ok: false` with every issue,
 * and no file. Trimmed names and the like are warnings on a good result.
 */
export function buildNachaFile(input: NachaFileInput): NachaBuildResult {
  const issues = new Collector();
  const { originator } = input;

  if (input.payments.length === 0) issues.error('no_payments', 'A file needs at least one payment');

  if (!isIsoDate(input.fileCreation.date)) issues.error('invalid_file_date', 'The file creation date must be YYYY-MM-DD', { field: 'fileCreation.date' });
  const fileTime = input.fileCreation.time;
  if (fileTime !== undefined && !validTime(fileTime)) issues.error('invalid_file_time', 'The file creation time must be HHMM', { field: 'fileCreation.time' });
  if (!isIsoDate(input.effectiveEntryDate)) issues.error('invalid_effective_date', 'The effective entry date must be YYYY-MM-DD', { field: 'effectiveEntryDate' });
  const fileDate = isIsoDate(input.fileCreation.date) ? input.fileCreation.date : '2000-01-01';

  const modifier = input.fileIdModifier ?? 'A';
  if (!/^[A-Z0-9]$/.test(modifier)) issues.error('invalid_file_id_modifier', 'The file ID modifier is one letter A-Z or digit 0-9', { field: 'fileIdModifier' });

  validRouting(originator.immediateDestination, issues, 'immediateDestination');
  const odfiRouting = originator.odfiRoutingNumber ?? originator.immediateDestination;
  if (originator.odfiRoutingNumber !== undefined) validRouting(odfiRouting, issues, 'odfiRoutingNumber');

  const originRaw = originator.immediateOrigin.replace(/\s/g, '').toUpperCase();
  const immediateOrigin = /^\d{9}$/.test(originRaw) ? ` ${originRaw}` : originRaw;
  if (!/^[A-Z0-9 ]{10}$/.test(immediateOrigin)) {
    issues.error('invalid_immediate_origin', 'The immediate origin is a 10-character company ID or a 9-digit routing number', { field: 'immediateOrigin' });
  }

  const companyIdRaw = originator.companyIdentification.replace(/[\s-]/g, '').toUpperCase();
  const companyId = /^\d{9}$/.test(companyIdRaw) ? `1${companyIdRaw}` : companyIdRaw;
  if (!/^[A-Z0-9]{10}$/.test(companyId)) {
    issues.error('invalid_company_identification', 'The company identification is 10 characters (identifier code plus ID)', { field: 'companyIdentification' });
  }

  const description = textField(input.entryDescription ?? 'VENDOR PAY', 10, issues, 'entryDescription', 'description_trimmed');
  if (RESERVED_DESCRIPTIONS.has(description)) {
    issues.error('reserved_entry_description', `"${description}" is reserved by Nacha and cannot describe a vendor payment run`, { field: 'entryDescription' });
  }

  const sameDay = Boolean(input.sameDay);
  let sameDayTime: string = DEFAULT_SAME_DAY_SETTLEMENT;
  if (typeof input.sameDay === 'object') {
    sameDayTime = input.sameDay.settlementTime;
    if (!validTime(sameDayTime)) issues.error('invalid_same_day_time', 'The same-day settlement time must be HHMM', { field: 'sameDay.settlementTime' });
  }
  if (isIsoDate(input.effectiveEntryDate)) {
    if (sameDay && input.effectiveEntryDate !== fileDate) {
      issues.warn('same_day_effective_date_mismatch', 'A Same Day ACH file carries its own date as the effective entry date');
    }
    if (!sameDay && input.effectiveEntryDate <= fileDate) {
      issues.warn('effective_date_not_after_file_date', 'An effective entry date on or before the file date is processed as Same Day ACH or rejected');
    }
    if (!isAchBankingDay(input.effectiveEntryDate)) {
      issues.warn('effective_date_not_banking_day', 'The effective entry date is not a banking day; settlement moves to the next one');
    }
  }

  const destinationName = textField(originator.immediateDestinationName, 23, issues, 'immediateDestinationName', 'name_trimmed');
  const originName = textField(originator.immediateOriginName, 23, issues, 'immediateOriginName', 'name_trimmed');
  const companyName = textField(originator.companyName, 16, issues, 'companyName', 'name_trimmed');
  const discretionary = textField(originator.companyDiscretionaryData ?? '', 20, issues, 'companyDiscretionaryData', 'description_trimmed');
  const reference = textField(originator.referenceCode ?? '', 8, issues, 'referenceCode', 'description_trimmed');
  const descriptiveDate = sameDay
    ? `SD${sameDayTime}`
    : textField(input.descriptiveDate ?? '', 6, issues, 'descriptiveDate', 'description_trimmed');

  const offset = originator.offsetAccount;
  const balanced = Boolean(input.balanced);
  let offsetEntry: Omit<PreparedEntry, 'cents'> | null = null;
  if (balanced) {
    if (!offset) {
      issues.error('missing_offset_account', 'A balanced file needs the originator\'s offset account', { field: 'offsetAccount' });
    } else {
      const routingOk = validRouting(offset.routingNumber, issues, 'offsetAccount.routingNumber');
      const account = cleanAccount(offset.accountNumber);
      if (!account) issues.error('invalid_account_number', 'The offset account number must be 1 to 17 letters, digits or hyphens', { field: 'offsetAccount.accountNumber' });
      if (routingOk && account) {
        offsetEntry = {
          kind: 'offset',
          paymentId: null,
          secHeader: 'CCD',
          transactionCode: TRANSACTION_CODES[offset.accountType === 'savings' ? 'savings' : 'checking'].debit,
          rdfi: offset.routingNumber.slice(0, 8),
          checkDigit: offset.routingNumber.slice(8, 9),
          account,
          identification: textField(offset.identification ?? '', 15, issues, 'offsetAccount.identification', 'identification_trimmed'),
          name: textField(offset.name ?? originator.companyName, 22, issues, 'offsetAccount.name', 'name_trimmed'),
          addenda: [],
        };
      }
    }
  }

  const entries = prepareEntries(input, issues, fileDate);
  const firstTrace = input.startingTraceSequence ?? 1;
  const batchesNeeded = BATCH_ORDER.filter((code) => entries.some((entry) => entry.secHeader === code)).length;
  const entryTotal = entries.length + (offsetEntry ? batchesNeeded : 0);
  if (firstTrace < 1 || firstTrace + entryTotal - 1 > 9_999_999) {
    issues.error('file_too_large', 'The trace sequence would run past 9,999,999', { field: 'startingTraceSequence' });
  }
  if (issues.errors.length > 0) return { ok: false, errors: issues.errors, warnings: issues.warnings };

  // Lines. Every record is checked to be 94 characters as it is made.
  const odfi = odfiRouting.slice(0, 8);
  const lines: string[] = [];
  const traces: NachaTrace[] = [];
  const batches: NachaBatchSummary[] = [];
  let traceSequence = input.startingTraceSequence ?? 1;
  let batchNumber = input.startingBatchNumber ?? 1;
  let fileHashParts = 0;
  let fileDebit = 0;
  let fileCredit = 0;
  let fileEntryAddenda = 0;

  const destination = ` ${originator.immediateDestination}`;
  lines.push(
    assertLine(
      `101${destination}${alpha(immediateOrigin, 10)}${yymmdd(fileDate)}${alpha(fileTime ?? '', 4)}${modifier}094101${alpha(destinationName, 23)}${alpha(originName, 23)}${alpha(reference, 8)}`,
    ),
  );

  for (const secCode of BATCH_ORDER) {
    const group = entries.filter((entry) => entry.secHeader === secCode);
    if (group.length === 0) continue;

    const creditCents = group.reduce((sum, entry) => sum + entry.cents, 0);
    const batchEntries: PreparedEntry[] = [...group];
    if (offsetEntry && creditCents > 0) batchEntries.push({ ...offsetEntry, cents: creditCents });
    const hasDebit = batchEntries.some((entry) => entry.kind === 'offset');
    const serviceClass: NachaServiceClass = hasDebit ? 200 : 220;
    const batchNo = numeric(batchNumber, 7);

    lines.push(
      assertLine(
        `5${serviceClass}${alpha(companyName, 16)}${alpha(discretionary, 20)}${alpha(companyId, 10)}${secCode}${alpha(description, 10)}${alpha(descriptiveDate, 6)}${yymmdd(input.effectiveEntryDate)}   1${odfi}${batchNo}`,
      ),
    );

    let entryAddendaCount = 0;
    let debitCents = 0;
    let batchCredit = 0;
    const rdfiIds: string[] = [];

    for (const entry of batchEntries) {
      const trace = `${odfi}${numeric(traceSequence, 7)}`;
      traceSequence += 1;
      const amount = numeric(entry.cents, 10);
      const indicator = entry.addenda.length > 0 ? '1' : '0';
      if (secCode === 'CTX') {
        lines.push(
          assertLine(
            `6${entry.transactionCode}${entry.rdfi}${entry.checkDigit}${alpha(entry.account, 17)}${amount}${alpha(entry.identification, 15)}${numeric(entry.addenda.length, 4)}${alpha(entry.name, 16)}    ${indicator}${trace}`,
          ),
        );
      } else {
        lines.push(
          assertLine(
            `6${entry.transactionCode}${entry.rdfi}${entry.checkDigit}${alpha(entry.account, 17)}${amount}${alpha(entry.identification, 15)}${alpha(entry.name, 22)}  ${indicator}${trace}`,
          ),
        );
      }
      entryAddendaCount += 1;
      entry.addenda.forEach((text, index) => {
        lines.push(assertLine(`705${alpha(text, NACHA_ADDENDA_TEXT_LENGTH)}${numeric(index + 1, 4)}${trace.slice(8)}`));
        entryAddendaCount += 1;
      });

      rdfiIds.push(entry.rdfi);
      if (entry.kind === 'offset') debitCents += entry.cents;
      else batchCredit += entry.cents;
      traces.push({ paymentId: entry.paymentId, kind: entry.kind, traceNumber: trace, batchNumber });
    }

    const batchHash = hashOf(rdfiIds);
    lines.push(
      assertLine(
        `8${serviceClass}${numeric(entryAddendaCount, 6)}${numeric(batchHash, 10)}${numeric(debitCents, 12)}${numeric(batchCredit, 12)}${alpha(companyId, 10)}${' '.repeat(19)}${' '.repeat(6)}${odfi}${batchNo}`,
      ),
    );

    batches.push({
      batchNumber,
      secCode,
      serviceClassCode: serviceClass,
      entryAddendaCount,
      entryHash: numeric(batchHash, 10),
      totalDebitCents: debitCents,
      totalCreditCents: batchCredit,
    });
    batchNumber += 1;
    fileHashParts += batchHash;
    fileDebit += debitCents;
    fileCredit += batchCredit;
    fileEntryAddenda += entryAddendaCount;
  }

  const fileHash = fileHashParts % 10_000_000_000;
  const recordsBeforeControl = lines.length + 1;
  const blockCount = Math.ceil(recordsBeforeControl / NACHA_BLOCKING_FACTOR);
  lines.push(
    assertLine(
      `9${numeric(batches.length, 6)}${numeric(blockCount, 6)}${numeric(fileEntryAddenda, 8)}${numeric(fileHash, 10)}${numeric(fileDebit, 12)}${numeric(fileCredit, 12)}${' '.repeat(39)}`,
    ),
  );
  while (lines.length % NACHA_BLOCKING_FACTOR !== 0) lines.push('9'.repeat(NACHA_RECORD_LENGTH));

  const lineEnding = input.lineEnding ?? '\r\n';
  return {
    ok: true,
    content: lines.join(lineEnding) + lineEnding,
    lines,
    recordCount: lines.length,
    blockCount,
    batchCount: batches.length,
    entryAddendaCount: fileEntryAddenda,
    entryHash: numeric(fileHash, 10),
    totalDebitCents: fileDebit,
    totalCreditCents: fileCredit,
    batches,
    traces,
    warnings: issues.warnings,
  };
}

// ---------------------------------------------------------------------------
// Verifier

export interface NachaVerification {
  ok: boolean;
  issues: NachaIssue[];
  batchCount: number;
  entryAddendaCount: number;
  entryHash: string;
  totalDebitCents: number;
  totalCreditCents: number;
}

const KNOWN_TRANSACTION_CODES = new Set(['22', '23', '24', '27', '28', '29', '32', '33', '34', '37', '38', '39']);
const PRENOTE_CODES = new Set(['23', '28', '33', '38']);
const DEBIT_CODES = new Set(['27', '28', '37', '38']);

/**
 * Re-reads a NACHA file and checks what a bank's intake would: record lengths
 * and order, counts, entry hashes, totals, trace numbers, addenda numbering
 * and the blocking padding. It does not know the originator's intent, so a
 * file that passes can still be the wrong payment run.
 */
export function verifyNachaFile(content: string): NachaVerification {
  const issues: NachaIssue[] = [];
  const err = (code: NachaIssueCode, message: string): void => {
    issues.push({ severity: 'error', code, message });
  };
  const lines = content.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const empty: NachaVerification = {
    ok: false,
    issues,
    batchCount: 0,
    entryAddendaCount: 0,
    entryHash: '0'.repeat(10),
    totalDebitCents: 0,
    totalCreditCents: 0,
  };
  if (lines.length === 0) {
    err('record_count', 'The file is empty');
    return empty;
  }

  lines.forEach((line, index) => {
    if (line.length !== NACHA_RECORD_LENGTH) err('record_length', `Line ${index + 1} is ${line.length} characters, not ${NACHA_RECORD_LENGTH}`);
    else if (/[^\x20-\x7e]/.test(line)) err('invalid_character', `Line ${index + 1} has a character outside printable ASCII`);
  });
  if (lines.length % NACHA_BLOCKING_FACTOR !== 0) err('blocking', `The file has ${lines.length} records, not a multiple of ${NACHA_BLOCKING_FACTOR}`);
  if (lines[0]?.[0] !== '1') err('record_order', 'The file must start with a file header (record type 1)');

  let batches = 0;
  let totalEntryAddenda = 0;
  let totalHash = 0;
  let totalDebit = 0;
  let totalCredit = 0;

  interface OpenBatch {
    header: string;
    entries: number;
    hash: number;
    debit: number;
    credit: number;
    lastEntryTrace: string | null;
    lastEntryAddendaIndicator: boolean;
    addendaSeen: number;
    expectedAddenda: number | null;
  }
  let batch: OpenBatch | null = null;
  let fileControlAt = -1;

  const closeEntry = (b: OpenBatch): void => {
    if (b.lastEntryAddendaIndicator && b.addendaSeen === 0) err('addenda_sequence', 'An entry flags an addenda record but none follows');
    if (b.expectedAddenda !== null && b.expectedAddenda !== b.addendaSeen) {
      err('addenda_sequence', `A CTX entry announces ${b.expectedAddenda} addenda records but ${b.addendaSeen} follow`);
    }
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const type = line[0];
    if (line.length !== NACHA_RECORD_LENGTH) continue;
    if (fileControlAt >= 0) {
      if (line !== '9'.repeat(NACHA_RECORD_LENGTH)) err('blocking', `Line ${i + 1} after the file control is not a padding record`);
      continue;
    }
    if (type === '5') {
      if (batch) err('record_order', `Line ${i + 1}: a batch header opens before the previous batch closed`);
      batch = {
        header: line,
        entries: 0,
        hash: 0,
        debit: 0,
        credit: 0,
        lastEntryTrace: null,
        lastEntryAddendaIndicator: false,
        addendaSeen: 0,
        expectedAddenda: null,
      };
    } else if (type === '6') {
      if (!batch) {
        err('record_order', `Line ${i + 1}: an entry detail outside a batch`);
        continue;
      }
      closeEntry(batch);
      const code = line.slice(1, 3);
      const rdfi = line.slice(3, 11);
      const check = line.slice(11, 12);
      const cents = Number(line.slice(29, 39));
      const sec = batch.header.slice(50, 53);
      const trace = line.slice(79, 94);
      const indicator = line.slice(78, 79) === '1';
      if (!KNOWN_TRANSACTION_CODES.has(code)) err('transaction_code', `Line ${i + 1}: transaction code ${code} is not valid`);
      if (!abaChecksumValid(rdfi + check)) err('invalid_routing_checksum', `Line ${i + 1}: routing ${rdfi}${check} fails the ABA checksum`);
      if (cents === 0 && !PRENOTE_CODES.has(code)) err('transaction_code', `Line ${i + 1}: a zero-dollar entry must be a prenote`);
      if (cents > 0 && PRENOTE_CODES.has(code)) err('transaction_code', `Line ${i + 1}: a prenote must be zero dollars`);
      if (trace.slice(0, 8) !== batch.header.slice(79, 87)) err('trace_number', `Line ${i + 1}: trace number does not start with the ODFI identification`);
      if (batch.lastEntryTrace !== null && trace <= batch.lastEntryTrace) err('trace_number', `Line ${i + 1}: trace numbers must ascend within a batch`);
      batch.lastEntryTrace = trace;
      batch.lastEntryAddendaIndicator = indicator;
      batch.addendaSeen = 0;
      batch.expectedAddenda = sec === 'CTX' ? Number(line.slice(54, 58)) : null;
      batch.entries += 1;
      batch.hash += Number(rdfi);
      if (DEBIT_CODES.has(code)) batch.debit += cents;
      else batch.credit += cents;
    } else if (type === '7') {
      if (!batch || batch.lastEntryTrace === null) {
        err('record_order', `Line ${i + 1}: an addenda record without an entry`);
        continue;
      }
      batch.entries += 1;
      batch.addendaSeen += 1;
      if (line.slice(1, 3) !== '05') err('addenda_sequence', `Line ${i + 1}: addenda type code ${line.slice(1, 3)} is not 05`);
      if (Number(line.slice(83, 87)) !== batch.addendaSeen) err('addenda_sequence', `Line ${i + 1}: addenda sequence number is out of order`);
      if (line.slice(87, 94) !== batch.lastEntryTrace.slice(8)) err('addenda_sequence', `Line ${i + 1}: addenda entry detail sequence does not match its entry`);
      if (!batch.lastEntryAddendaIndicator) err('addenda_sequence', `Line ${i + 1}: addenda follows an entry that does not flag one`);
    } else if (type === '8') {
      if (!batch) {
        err('record_order', `Line ${i + 1}: a batch control without a batch header`);
        continue;
      }
      closeEntry(batch);
      const hashSum = batch.hash % 10_000_000_000;
      if (Number(line.slice(4, 10)) !== batch.entries) err('record_count', `Line ${i + 1}: batch control counts ${Number(line.slice(4, 10))} records, found ${batch.entries}`);
      if (Number(line.slice(10, 20)) !== hashSum) err('entry_hash', `Line ${i + 1}: batch entry hash is ${line.slice(10, 20)}, expected ${String(hashSum).padStart(10, '0')}`);
      if (Number(line.slice(20, 32)) !== batch.debit) err('control_total', `Line ${i + 1}: batch debit total does not match its entries`);
      if (Number(line.slice(32, 44)) !== batch.credit) err('control_total', `Line ${i + 1}: batch credit total does not match its entries`);
      if (line.slice(1, 4) !== batch.header.slice(1, 4)) err('control_total', `Line ${i + 1}: batch control service class differs from the header`);
      if (line.slice(44, 54) !== batch.header.slice(40, 50)) err('control_total', `Line ${i + 1}: batch control company identification differs from the header`);
      if (line.slice(79, 94) !== batch.header.slice(79, 94)) err('control_total', `Line ${i + 1}: batch control ODFI and batch number differ from the header`);
      batches += 1;
      totalEntryAddenda += batch.entries;
      totalHash += hashSum;
      totalDebit += batch.debit;
      totalCredit += batch.credit;
      batch = null;
    } else if (type === '9') {
      if (batch) err('record_order', `Line ${i + 1}: the file control comes before the batch closed`);
      fileControlAt = i;
      if (line === '9'.repeat(NACHA_RECORD_LENGTH)) {
        err('record_order', `Line ${i + 1}: padding where the file control should be`);
        continue;
      }
      const blocks = Math.ceil(lines.length / NACHA_BLOCKING_FACTOR);
      const hashSum = totalHash % 10_000_000_000;
      if (Number(line.slice(1, 7)) !== batches) err('record_count', `File control counts ${Number(line.slice(1, 7))} batches, found ${batches}`);
      if (Number(line.slice(7, 13)) !== Math.ceil((i + 1) / NACHA_BLOCKING_FACTOR)) err('blocking', `File control block count is ${Number(line.slice(7, 13))}, expected ${Math.ceil((i + 1) / NACHA_BLOCKING_FACTOR)}`);
      if (blocks !== Math.ceil((i + 1) / NACHA_BLOCKING_FACTOR)) err('blocking', 'The padding after the file control does not fill the last block exactly');
      if (Number(line.slice(13, 21)) !== totalEntryAddenda) err('record_count', `File control counts ${Number(line.slice(13, 21))} entry and addenda records, found ${totalEntryAddenda}`);
      if (Number(line.slice(21, 31)) !== hashSum) err('entry_hash', `File entry hash is ${line.slice(21, 31)}, expected ${String(hashSum).padStart(10, '0')}`);
      if (Number(line.slice(31, 43)) !== totalDebit) err('control_total', 'File debit total does not match the batches');
      if (Number(line.slice(43, 55)) !== totalCredit) err('control_total', 'File credit total does not match the batches');
    } else {
      err('record_order', `Line ${i + 1}: unknown record type ${type ?? ''}`);
    }
  }
  if (fileControlAt < 0) err('record_order', 'The file has no file control record');
  if (batch) err('record_order', 'The last batch was never closed');

  return {
    ok: issues.length === 0,
    issues,
    batchCount: batches,
    entryAddendaCount: totalEntryAddenda,
    entryHash: String(totalHash % 10_000_000_000).padStart(10, '0'),
    totalDebitCents: totalDebit,
    totalCreditCents: totalCredit,
  };
}
