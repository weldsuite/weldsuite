/**
 * IRIS Taxpayer Portal bulk upload files for Forms 1099-NEC and 1099-MISC.
 *
 * What is known (IRS Pub 5719, the IRIS working group Q&A and notes of
 * October 2024 to March 2026): one form type per file; at most 100 records per
 * file, header row excluded; column headers are validated against the
 * template the portal hands out and the file is sensitive to stray spaces,
 * commas and blank rows; checkboxes are `Y` / `N`; required columns are
 * marked with an asterisk in the template; recipient TIN type (`SSN`, `EIN`),
 * `Recipient Taxpayer ID Number`, `Recipient Name Type` (`B` for business,
 * `I` for individual) and `Business Name Line 1` / `Line 2` are real column
 * names (a sole proprietor with a DBA goes in as name type B: the person's
 * name on line 1 and the DBA on line 2).
 *
 * What is NOT verified: the full header row of each template. The IRS only
 * publishes it behind the portal login (CSV upload tile, FAQ 8) and changes
 * it by form year (a 2026 notice fixed a MISC template that populated wrong
 * fields). `IRIS_NEC_COLUMNS` and `IRIS_MISC_COLUMNS` are therefore the best
 * known layout, reconstructed from the sources above and from a state
 * agency's description of the template (issuer columns A-S, recipient TIN
 * type in T, TIN in U, name type in V, business name lines in W-X, person
 * name in Y-AB). Download the current template from the portal, give its
 * header row to `generateIrisCsv` as `templateHeaders`, and the file is
 * written under those exact headers, with every column matched by name (and
 * aliases) and unknown columns left empty. `resolveIrisColumns` reports what
 * did not match.
 *
 * This is the only place a full TIN leaves the system besides the TIN
 * matching file.
 */

import {
  form1099Box,
  type Form1099BoxCode,
  type Form1099Type,
} from '../jurisdictions/us/form-1099';

export const IRIS_MAX_RECORDS_PER_FILE = 100;

export type IrisFormType = Form1099Type;

export interface IrisAddress {
  line1: string;
  line2?: string | null;
  city: string;
  /** Two-letter state or territory code. */
  state: string;
  /** 5 digits or ZIP+4. */
  zip: string;
  /** Two-letter code for a foreign address; empty for the US. */
  country?: string | null;
}

export interface IrisPayer {
  name: string;
  /** DBA or second name line. */
  nameLine2?: string | null;
  tinType: 'ein' | 'ssn';
  /** Full TIN. */
  tin: string;
  address: IrisAddress;
  phone?: string | null;
  email?: string | null;
}

export interface IrisRecipientState {
  code: string;
  payerStateNumber?: string | null;
  withheld?: number | null;
  income?: number | null;
}

export interface IrisRecipient {
  /** Shown in warnings. */
  id?: string;
  /** W-9 line 1. */
  legalName: string;
  /** W-9 line 2 (business or disregarded entity name). */
  businessName?: string | null;
  nameParts?: { first: string; middle?: string | null; last: string; suffix?: string | null };
  tinType: 'ein' | 'ssn' | 'itin';
  /** Full TIN, nine digits (hyphens allowed). */
  tin: string;
  address: IrisAddress;
  accountNumber?: string | null;
  secondTinNotice?: boolean;
  corrected?: boolean;
  /** Amount per box. Checkboxes use `directSales` and `fatca`. */
  boxes: Partial<Record<Form1099BoxCode, number>>;
  directSales?: boolean;
  fatca?: boolean;
  /** Up to two states. */
  states?: IrisRecipientState[];
}

export interface GenerateIrisCsvInput {
  taxYear: number;
  form: IrisFormType;
  payer: IrisPayer;
  recipients: IrisRecipient[];
  /** The header row of the template downloaded from the IRIS portal; overrides the built-in headers. */
  templateHeaders?: string[];
  /** Defaults to and is capped at 100. */
  maxRecordsPerFile?: number;
}

export interface IrisCsvFile {
  filename: string;
  content: string;
  recordCount: number;
  /** Problems with the records of this file (invalid TIN, truncated names, ...). */
  warnings: string[];
}

// Columns

type FormBoxKey = `box:${Form1099BoxCode}`;

export type IrisFieldKey =
  | 'form_type'
  | 'tax_year'
  | 'payer_tin_type'
  | 'payer_tin'
  | 'payer_name_type'
  | 'payer_name_1'
  | 'payer_name_2'
  | 'payer_first'
  | 'payer_middle'
  | 'payer_last'
  | 'payer_suffix'
  | 'payer_address_1'
  | 'payer_address_2'
  | 'payer_city'
  | 'payer_state'
  | 'payer_zip'
  | 'payer_country'
  | 'payer_phone'
  | 'payer_email'
  | 'recipient_tin_type'
  | 'recipient_tin'
  | 'recipient_name_type'
  | 'recipient_name_1'
  | 'recipient_name_2'
  | 'recipient_first'
  | 'recipient_middle'
  | 'recipient_last'
  | 'recipient_suffix'
  | 'recipient_address_1'
  | 'recipient_address_2'
  | 'recipient_city'
  | 'recipient_state'
  | 'recipient_zip'
  | 'recipient_country'
  | 'account_number'
  | 'second_tin_notice'
  | 'corrected'
  | 'direct_sales'
  | 'fatca'
  | 'state1_code'
  | 'state1_withheld'
  | 'state1_number'
  | 'state1_income'
  | 'state2_code'
  | 'state2_withheld'
  | 'state2_number'
  | 'state2_income'
  | FormBoxKey;

export interface IrisColumn {
  header: string;
  key: IrisFieldKey;
  /** Other spellings of the header that map to the same field when matching a downloaded template. */
  aliases?: string[];
}

const col = (header: string, key: IrisFieldKey, aliases?: string[]): IrisColumn => ({ header, key, aliases });

const PAYER_AND_RECIPIENT: IrisColumn[] = [
  col('Form Type', 'form_type'),
  col('Tax Year', 'tax_year'),
  col('Payer TIN Type', 'payer_tin_type', ['Issuer TIN Type']),
  col('Payer Taxpayer ID Number', 'payer_tin', ['Issuer Taxpayer ID Number', 'Payer TIN']),
  col('Payer Name Type', 'payer_name_type', ['Issuer Name Type']),
  col('Payer Business or Entity Name Line 1', 'payer_name_1', ['Payer Business Name Line 1', 'Issuer Business or Entity Name Line 1']),
  col('Payer Business or Entity Name Line 2', 'payer_name_2', ['Payer Business Name Line 2', 'Issuer Business or Entity Name Line 2']),
  col('Payer First Name', 'payer_first', ['Issuer First Name']),
  col('Payer Middle Name', 'payer_middle', ['Issuer Middle Name']),
  col('Payer Last Name', 'payer_last', ['Issuer Last Name']),
  col('Payer Suffix', 'payer_suffix', ['Issuer Suffix']),
  col('Payer Address Line 1', 'payer_address_1', ['Issuer Address Line 1']),
  col('Payer Address Line 2', 'payer_address_2', ['Issuer Address Line 2']),
  col('Payer City', 'payer_city', ['Issuer City']),
  col('Payer State', 'payer_state', ['Issuer State']),
  col('Payer ZIP Code', 'payer_zip', ['Issuer ZIP Code', 'Payer Zip']),
  col('Payer Country', 'payer_country', ['Issuer Country']),
  col('Payer Phone Number', 'payer_phone', ['Issuer Phone Number', 'Payer Telephone Number']),
  col('Payer Email Address', 'payer_email', ['Issuer Email Address']),
  col('Recipient TIN Type', 'recipient_tin_type'),
  col('Recipient Taxpayer ID Number', 'recipient_tin', ['Recipient TIN']),
  col('Recipient Name Type', 'recipient_name_type'),
  col('Recipient Business or Entity Name Line 1', 'recipient_name_1', ['Business Name Line 1', 'Recipient Business Name Line 1']),
  col('Recipient Business or Entity Name Line 2', 'recipient_name_2', ['Business Name Line 2', 'Recipient Business Name Line 2']),
  col('Recipient First Name', 'recipient_first'),
  col('Recipient Middle Name', 'recipient_middle'),
  col('Recipient Last Name', 'recipient_last'),
  col('Recipient Suffix', 'recipient_suffix'),
  col('Recipient Address Line 1', 'recipient_address_1'),
  col('Recipient Address Line 2', 'recipient_address_2'),
  col('Recipient City', 'recipient_city'),
  col('Recipient State', 'recipient_state'),
  col('Recipient ZIP Code', 'recipient_zip', ['Recipient Zip']),
  col('Recipient Country', 'recipient_country'),
  col('Form Account Number', 'account_number', ['Account Number']),
  col('Second TIN Notice', 'second_tin_notice'),
  col('Corrected', 'corrected', ['Corrected Indicator']),
];

const STATES: IrisColumn[] = [
  col('State 1 - State Code', 'state1_code'),
  col('State 1 - State Tax Withheld', 'state1_withheld'),
  col("State 1 - State/Payer's State No.", 'state1_number'),
  col('State 1 - State Income', 'state1_income'),
  col('State 2 - State Code', 'state2_code'),
  col('State 2 - State Tax Withheld', 'state2_withheld'),
  col("State 2 - State/Payer's State No.", 'state2_number'),
  col('State 2 - State Income', 'state2_income'),
];

/** Best-known 1099-NEC layout; replace with the portal's header row through `templateHeaders`. */
export const IRIS_NEC_COLUMNS: readonly IrisColumn[] = [
  ...PAYER_AND_RECIPIENT,
  col('Box 1 - Nonemployee Compensation', 'box:nec_1', ['Box 1a - Nonemployee Compensation']),
  col('Box 2 - Direct Sales Indicator', 'direct_sales', ['Box 2 - Direct Sales', 'Box 2 - Payer Made Direct Sales Totaling $5,000 or More of Consumer Products to Recipient for Resale']),
  col('Box 3 - Excess Golden Parachute Payments', 'box:nec_3'),
  col('Box 4 - Federal Income Tax Withheld', 'box:nec_4'),
  ...STATES,
];

/** Best-known 1099-MISC layout; replace with the portal's header row through `templateHeaders`. */
export const IRIS_MISC_COLUMNS: readonly IrisColumn[] = [
  ...PAYER_AND_RECIPIENT,
  col('Box 1 - Rents', 'box:misc_1'),
  col('Box 2 - Royalties', 'box:misc_2'),
  col('Box 3 - Other Income', 'box:misc_3'),
  col('Box 4 - Federal Income Tax Withheld', 'box:misc_4'),
  col('Box 5 - Fishing Boat Proceeds', 'box:misc_5'),
  col('Box 6 - Medical and Health Care Payments', 'box:misc_6'),
  col('Box 7 - Direct Sales Indicator', 'direct_sales', ['Box 7 - Direct Sales', 'Box 7 - Payer Made Direct Sales Totaling $5,000 or More of Consumer Products to Recipient for Resale']),
  col('Box 8 - Substitute Payments in Lieu of Dividends or Interest', 'box:misc_8'),
  col('Box 9 - Crop Insurance Proceeds', 'box:misc_9'),
  col('Box 10 - Gross Proceeds Paid to an Attorney', 'box:misc_10'),
  col('Box 11 - Fish Purchased for Resale', 'box:misc_11'),
  col('Box 12 - Section 409A Deferrals', 'box:misc_12'),
  col('Box 13 - FATCA Filing Requirement', 'fatca'),
  col('Box 14 - Nonqualified Deferred Compensation', 'box:misc_14'),
  ...STATES,
];

export function irisColumnsFor(form: IrisFormType): readonly IrisColumn[] {
  return form === 'nec' ? IRIS_NEC_COLUMNS : IRIS_MISC_COLUMNS;
}

export function irisFormLabel(form: IrisFormType): string {
  return form === 'nec' ? '1099-NEC' : '1099-MISC';
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9$]/g, '');
}

export interface ResolvedIrisColumns {
  /** Header cell as written to the file and the field it carries (null = left empty). */
  columns: Array<{ header: string; key: IrisFieldKey | null }>;
  /** Template headers with no matching field; their cells stay empty. */
  unmatchedHeaders: string[];
  /** Amount and identity fields of this layout that no template column carries, so the data would be lost. */
  missingFields: IrisFieldKey[];
}

/**
 * The columns of a file: the built-in layout, or the downloaded template's
 * header row with each header matched to a field by name or alias.
 */
export function resolveIrisColumns(form: IrisFormType, templateHeaders?: string[]): ResolvedIrisColumns {
  const builtIn = irisColumnsFor(form);
  if (!templateHeaders || templateHeaders.length === 0) {
    return { columns: builtIn.map((column) => ({ header: column.header, key: column.key })), unmatchedHeaders: [], missingFields: [] };
  }
  const lookup = new Map<string, IrisFieldKey>();
  for (const column of builtIn) {
    lookup.set(normalizeHeader(column.header), column.key);
    for (const alias of column.aliases ?? []) lookup.set(normalizeHeader(alias), column.key);
  }
  const used = new Set<IrisFieldKey>();
  const unmatchedHeaders: string[] = [];
  const columns = templateHeaders.map((header) => {
    const key = lookup.get(normalizeHeader(header)) ?? null;
    if (key === null) unmatchedHeaders.push(header);
    else used.add(key);
    return { header, key };
  });
  const missingFields = builtIn.map((column) => column.key).filter((key) => !used.has(key));
  return { columns, unmatchedHeaders, missingFields };
}

// Cleaning

const NAME_MAX = 40;
const FIRST_MAX = 20;
const MIDDLE_MAX = 20;
const LAST_MAX = 20;
const SUFFIX_MAX = 10;
const ADDRESS_MAX = 35;
const CITY_MAX = 22;
const ACCOUNT_MAX = 20;

/** Letters, digits, spaces and `& ' - # ( )`, no accents, no leading `= + @ -`, single spaces. */
export function cleanIrisText(value: string | null | undefined, allowSlash = false): string {
  const pattern = allowSlash ? /[^A-Za-z0-9 &'\-#()/]/g : /[^A-Za-z0-9 &'\-#()]/g;
  return (value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(pattern, '')
    .replace(/\s+/g, ' ')
    .replace(/^[-=+@\s]+/, '')
    .trim();
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function amount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const cents = Math.round(value * 100);
  if (cents === 0) return '';
  return (cents / 100).toFixed(2);
}

function flag(value: boolean | undefined): string {
  return value ? 'Y' : 'N';
}

const TIN_TYPE_LABEL = { ein: 'EIN', ssn: 'SSN', itin: 'ITIN' } as const;

export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value) || value !== value.trim()) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);

export function splitPersonName(full: string): { first: string; middle: string; last: string; suffix: string } {
  const tokens = cleanIrisText(full.replace(/,/g, ' ').replace(/\./g, ' ')).split(' ').filter(Boolean);
  let suffix = '';
  const lastToken = tokens[tokens.length - 1];
  if (tokens.length >= 3 && lastToken && SUFFIXES.has(lastToken.toUpperCase())) {
    suffix = lastToken;
    tokens.pop();
  }
  if (tokens.length === 0) return { first: '', middle: '', last: '', suffix };
  if (tokens.length === 1) return { first: '', middle: '', last: tokens[0]!, suffix };
  return { first: tokens[0]!, middle: tokens.slice(1, -1).join(' '), last: tokens[tokens.length - 1]!, suffix };
}

interface NameBlock {
  nameType: 'B' | 'I';
  line1: string;
  line2: string;
  first: string;
  middle: string;
  last: string;
  suffix: string;
}

function fit(value: string, max: number, label: string, warnings: string[]): string {
  if (value.length <= max) return value;
  warnings.push(`${label} is longer than ${max} characters and was shortened.`);
  return value.slice(0, max).trim();
}

/** Wraps a long business name onto line 2 at a word boundary when line 2 is free. */
function businessLines(name: string, second: string, label: string, warnings: string[]): { line1: string; line2: string } {
  if (name.length <= NAME_MAX) return { line1: name, line2: fit(second, NAME_MAX, `${label} line 2`, warnings) };
  if (second) return { line1: fit(name, NAME_MAX, `${label} line 1`, warnings), line2: fit(second, NAME_MAX, `${label} line 2`, warnings) };
  const cut = name.lastIndexOf(' ', NAME_MAX);
  if (cut <= 0) return { line1: fit(name, NAME_MAX, `${label} line 1`, warnings), line2: '' };
  return { line1: name.slice(0, cut).trim(), line2: fit(name.slice(cut + 1).trim(), NAME_MAX, `${label} line 2`, warnings) };
}

function recipientName(recipient: IrisRecipient, label: string, warnings: string[]): NameBlock {
  const legal = cleanIrisText(recipient.legalName);
  const business = cleanIrisText(recipient.businessName);
  const empty = { first: '', middle: '', last: '', suffix: '' };

  if (recipient.tinType === 'ein') {
    // The company's legal name; a trade name goes on line 2.
    const { line1, line2 } = businessLines(legal, business && business !== legal ? business : '', label, warnings);
    return { nameType: 'B', line1, line2, ...empty };
  }
  if (business && business !== legal) {
    // Individual with a DBA or disregarded LLC: IRIS Q&A has the person on line 1 and the business on line 2, name type B.
    const { line1, line2 } = businessLines(legal, business, label, warnings);
    return { nameType: 'B', line1, line2, ...empty };
  }
  const parts = recipient.nameParts
    ? {
        first: cleanIrisText(recipient.nameParts.first),
        middle: cleanIrisText(recipient.nameParts.middle),
        last: cleanIrisText(recipient.nameParts.last),
        suffix: cleanIrisText(recipient.nameParts.suffix),
      }
    : splitPersonName(legal);
  if (!parts.first || !parts.last) warnings.push(`${label}: the individual name needs a first and a last name.`);
  return {
    nameType: 'I',
    line1: '',
    line2: '',
    first: fit(parts.first, FIRST_MAX, `${label} first name`, warnings),
    middle: fit(parts.middle, MIDDLE_MAX, `${label} middle name`, warnings),
    last: fit(parts.last, LAST_MAX, `${label} last name`, warnings),
    suffix: fit(parts.suffix, SUFFIX_MAX, `${label} suffix`, warnings),
  };
}

interface AddressBlock {
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

function address(source: IrisAddress, label: string, warnings: string[]): AddressBlock {
  const zip = digits(source.zip);
  if (zip.length !== 5 && zip.length !== 9 && !source.country) warnings.push(`${label}: ZIP code must have 5 or 9 digits.`);
  const state = cleanIrisText(source.state).toUpperCase();
  const line1 = fit(cleanIrisText(source.line1, true), ADDRESS_MAX, `${label} address line 1`, warnings);
  const city = fit(cleanIrisText(source.city), CITY_MAX, `${label} city`, warnings);
  if (!line1 || !city || !state) warnings.push(`${label}: the address is incomplete.`);
  return {
    line1,
    line2: fit(cleanIrisText(source.line2, true), ADDRESS_MAX, `${label} address line 2`, warnings),
    city,
    state,
    zip,
    country: cleanIrisText(source.country).toUpperCase(),
  };
}

function payerNameBlock(payer: IrisPayer, warnings: string[]): NameBlock {
  const legal = cleanIrisText(payer.name);
  const second = cleanIrisText(payer.nameLine2);
  const { line1, line2 } = businessLines(legal, second, 'Payer name', warnings);
  return { nameType: 'B', line1, line2, first: '', middle: '', last: '', suffix: '' };
}

// Records

interface RecordContext {
  taxYear: number;
  form: IrisFormType;
  payer: IrisPayer;
  payerName: NameBlock;
  payerAddress: AddressBlock;
  recipient: IrisRecipient;
  recipientNameBlock: NameBlock;
  recipientAddress: AddressBlock;
}

function stateValue(recipient: IrisRecipient, index: 0 | 1, field: 'code' | 'withheld' | 'number' | 'income'): string {
  const state = recipient.states?.[index];
  if (!state) return '';
  switch (field) {
    case 'code':
      return cleanIrisText(state.code).toUpperCase();
    case 'withheld':
      return amount(state.withheld);
    case 'number':
      return cleanIrisText(state.payerStateNumber);
    case 'income':
      return amount(state.income);
  }
}

function fieldValue(key: IrisFieldKey, ctx: RecordContext): string {
  const { payer, payerName, payerAddress, recipient, recipientNameBlock, recipientAddress } = ctx;
  if (key.startsWith('box:')) {
    const code = key.slice(4) as Form1099BoxCode;
    return form1099Box(code)?.kind === 'amount' ? amount(recipient.boxes[code]) : '';
  }
  switch (key) {
    case 'form_type':
      return irisFormLabel(ctx.form);
    case 'tax_year':
      return String(ctx.taxYear);
    case 'payer_tin_type':
      return TIN_TYPE_LABEL[payer.tinType];
    case 'payer_tin':
      return digits(payer.tin);
    case 'payer_name_type':
      return payerName.nameType;
    case 'payer_name_1':
      return payerName.line1;
    case 'payer_name_2':
      return payerName.line2;
    case 'payer_first':
    case 'payer_middle':
    case 'payer_last':
    case 'payer_suffix':
      return '';
    case 'payer_address_1':
      return payerAddress.line1;
    case 'payer_address_2':
      return payerAddress.line2;
    case 'payer_city':
      return payerAddress.city;
    case 'payer_state':
      return payerAddress.state;
    case 'payer_zip':
      return payerAddress.zip;
    case 'payer_country':
      return payerAddress.country;
    case 'payer_phone': {
      const phone = digits(payer.phone);
      return phone.length === 11 && phone.startsWith('1') ? phone.slice(1) : phone;
    }
    case 'payer_email':
      return (payer.email ?? '').trim();
    case 'recipient_tin_type':
      return TIN_TYPE_LABEL[recipient.tinType];
    case 'recipient_tin':
      return digits(recipient.tin);
    case 'recipient_name_type':
      return recipientNameBlock.nameType;
    case 'recipient_name_1':
      return recipientNameBlock.line1;
    case 'recipient_name_2':
      return recipientNameBlock.line2;
    case 'recipient_first':
      return recipientNameBlock.first;
    case 'recipient_middle':
      return recipientNameBlock.middle;
    case 'recipient_last':
      return recipientNameBlock.last;
    case 'recipient_suffix':
      return recipientNameBlock.suffix;
    case 'recipient_address_1':
      return recipientAddress.line1;
    case 'recipient_address_2':
      return recipientAddress.line2;
    case 'recipient_city':
      return recipientAddress.city;
    case 'recipient_state':
      return recipientAddress.state;
    case 'recipient_zip':
      return recipientAddress.zip;
    case 'recipient_country':
      return recipientAddress.country;
    case 'account_number':
      return cleanIrisText(recipient.accountNumber).replace(/ /g, '').slice(0, ACCOUNT_MAX);
    case 'second_tin_notice':
      return flag(recipient.secondTinNotice);
    case 'corrected':
      return flag(recipient.corrected);
    case 'direct_sales':
      return flag(recipient.directSales);
    case 'fatca':
      return flag(recipient.fatca);
    case 'state1_code':
      return stateValue(recipient, 0, 'code');
    case 'state1_withheld':
      return stateValue(recipient, 0, 'withheld');
    case 'state1_number':
      return stateValue(recipient, 0, 'number');
    case 'state1_income':
      return stateValue(recipient, 0, 'income');
    case 'state2_code':
      return stateValue(recipient, 1, 'code');
    case 'state2_withheld':
      return stateValue(recipient, 1, 'withheld');
    case 'state2_number':
      return stateValue(recipient, 1, 'number');
    case 'state2_income':
      return stateValue(recipient, 1, 'income');
    default:
      return '';
  }
}

/** Checks one record the way IRIS validates it; empty when it looks uploadable. */
export function validateIrisRecipient(recipient: IrisRecipient, form: IrisFormType): string[] {
  const issues: string[] = [];
  if (digits(recipient.tin).length !== 9) issues.push('The TIN must have 9 digits.');
  if (!cleanIrisText(recipient.legalName)) issues.push('The name is missing.');
  const anyAmount = Object.entries(recipient.boxes).some(([code, value]) => {
    const def = form1099Box(code);
    return def?.form === form && def.kind === 'amount' && Math.round((value ?? 0) * 100) > 0;
  });
  if (!anyAmount) issues.push(`No ${irisFormLabel(form)} amount.`);
  for (const [code, value] of Object.entries(recipient.boxes)) {
    if (Math.round((value ?? 0) * 100) < 0) issues.push(`Box ${code} is negative; IRIS accepts only positive amounts.`);
    const def = form1099Box(code);
    if (def && def.form !== form) issues.push(`Box ${code} belongs to the other form.`);
  }
  if ((recipient.states?.length ?? 0) > 2) issues.push('Only two states fit on the form.');
  return issues;
}

/**
 * Generates the IRIS upload files of one form type: header row plus at most
 * 100 records per file, split into numbered files. Warnings list what was
 * shortened or looks wrong; they do not stop the file from being written.
 */
export function generateIrisCsv(input: GenerateIrisCsvInput): IrisCsvFile[] {
  if (input.recipients.length === 0) return [];
  const limit = Math.max(1, Math.min(input.maxRecordsPerFile ?? IRIS_MAX_RECORDS_PER_FILE, IRIS_MAX_RECORDS_PER_FILE));
  const resolved = resolveIrisColumns(input.form, input.templateHeaders);
  const baseWarnings: string[] = resolved.unmatchedHeaders.map((header) => `Template column "${header}" is not recognised and stays empty.`);
  if (resolved.missingFields.length > 0) {
    baseWarnings.push(`The template has no column for: ${resolved.missingFields.join(', ')}.`);
  }

  const payerWarnings: string[] = [];
  const payerName = payerNameBlock(input.payer, payerWarnings);
  const payerAddress = address(input.payer.address, 'Payer', payerWarnings);
  if (digits(input.payer.tin).length !== 9) payerWarnings.push('Payer: the TIN must have 9 digits.');

  const total = Math.ceil(input.recipients.length / limit);
  const files: IrisCsvFile[] = [];
  for (let part = 0; part < total; part += 1) {
    const chunk = input.recipients.slice(part * limit, (part + 1) * limit);
    const warnings = [...baseWarnings, ...payerWarnings];
    const lines = [resolved.columns.map((column) => escapeCsvField(column.header)).join(',')];

    chunk.forEach((recipient, index) => {
      const label = `Recipient ${recipient.id ?? part * limit + index + 1}`;
      const recordWarnings: string[] = [];
      for (const issue of validateIrisRecipient(recipient, input.form)) recordWarnings.push(`${label}: ${issue}`);
      const ctx: RecordContext = {
        taxYear: input.taxYear,
        form: input.form,
        payer: input.payer,
        payerName,
        payerAddress,
        recipient,
        recipientNameBlock: recipientName(recipient, label, recordWarnings),
        recipientAddress: address(recipient.address, label, recordWarnings),
      };
      warnings.push(...recordWarnings);
      lines.push(
        resolved.columns
          .map((column) => escapeCsvField(column.key === null ? '' : fieldValue(column.key, ctx)))
          .join(','),
      );
    });

    const prefix = `iris-1099-${input.form}-${input.taxYear}`;
    files.push({
      filename: total === 1 ? `${prefix}.csv` : `${prefix}-${String(part + 1).padStart(3, '0')}-of-${String(total).padStart(3, '0')}.csv`,
      content: `${lines.join('\r\n')}\r\n`,
      recordCount: chunk.length,
      warnings,
    });
  }
  return files;
}
