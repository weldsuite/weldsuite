/**
 * IRS TIN Matching, bulk files (e-Services; Pub 2108A).
 *
 * Upload: a plain text file, one record per line, fields separated by
 * semicolons, no header row: `TIN type;TIN;Name;Account number`.
 * - TIN type: 1 = EIN, 2 = SSN, 3 = unknown.
 * - TIN: exactly nine digits, no hyphens or spaces.
 * - Name: 1-40 characters; letters, digits, spaces, hyphens and ampersands only
 *   (commas, apostrophes and other special characters are left out).
 * - Account number: optional, up to 20 alphanumeric characters, returned
 *   unchanged. WeldBooks puts the party id there.
 * - At most 100,000 records per file; there is no limit on the number of files.
 *
 * Result: the IRS returns each record with one extra field, an indicator 0-8.
 * Neither the delimiter nor the field order of the results file could be
 * confirmed from IRS text, so the parser reads the last field as the
 * indicator and takes the account number from the fourth field.
 *
 * ITINs are not a TIN type of the program, so they are not sent unless the
 * caller asks (`includeItins`); a no-match for an ITIN would wrongly look like
 * a bad TIN.
 */

export type TinMatchTinType = 'ein' | 'ssn' | 'itin' | 'unknown';

export interface TinMatchRecord {
  partyId: string;
  tinType: TinMatchTinType;
  /** Nine digits, hyphens allowed. */
  tin: string;
  name: string;
}

export const TIN_MATCH_MAX_RECORDS = 100_000;
export const TIN_MATCH_NAME_MAX = 40;
export const TIN_MATCH_ACCOUNT_MAX = 20;

export interface TinMatchFile {
  filename: string;
  content: string;
  recordCount: number;
}

export type TinMatchSkipReason =
  | 'invalid_tin'
  | 'missing_name'
  | 'duplicate'
  | 'itin_not_supported'
  | 'account_collision';

export interface TinMatchSkipped {
  partyId: string;
  reason: TinMatchSkipReason;
}

export interface TinMatchBuildOptions {
  /** Send ITINs as "unknown" instead of skipping them. */
  includeItins?: boolean;
  /** Filenames are `<prefix>-001.txt` and so on. */
  filenamePrefix?: string;
  /** Records per file; defaults to and is capped at 100,000. */
  maxRecordsPerFile?: number;
}

export interface TinMatchBuildResult {
  files: TinMatchFile[];
  skipped: TinMatchSkipped[];
  /** Account number sent for each record -> party id (ids are longer than 20 characters). */
  accountToParty: Record<string, string>;
}

const TIN_TYPE_CODE: Record<TinMatchTinType, string> = { ein: '1', ssn: '2', unknown: '3', itin: '3' };

/** Name as the program accepts it: letters, digits, spaces, hyphen and ampersand, up to 40 characters. */
export function sanitizeTinMatchName(name: string): string {
  const plain = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9 &-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, TIN_MATCH_NAME_MAX).trim();
}

/** Alphanumeric account number of at most 20 characters; the tail of a long id, which holds its random part. */
export function tinMatchAccountNumber(partyId: string): string {
  const alnum = partyId.replace(/[^A-Za-z0-9]/g, '');
  return alnum.length <= TIN_MATCH_ACCOUNT_MAX ? alnum : alnum.slice(-TIN_MATCH_ACCOUNT_MAX);
}

/** Builds the upload file(s) for a list of vendors. */
export function buildTinMatchingFiles(
  records: TinMatchRecord[],
  options: TinMatchBuildOptions = {},
): TinMatchBuildResult {
  const prefix = options.filenamePrefix ?? 'tin-matching';
  const perFile = Math.min(options.maxRecordsPerFile ?? TIN_MATCH_MAX_RECORDS, TIN_MATCH_MAX_RECORDS);
  const skipped: TinMatchSkipped[] = [];
  const accountToParty: Record<string, string> = {};
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    if (record.tinType === 'itin' && !options.includeItins) {
      skipped.push({ partyId: record.partyId, reason: 'itin_not_supported' });
      continue;
    }
    const digits = record.tin.replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(digits)) {
      skipped.push({ partyId: record.partyId, reason: 'invalid_tin' });
      continue;
    }
    const name = sanitizeTinMatchName(record.name);
    if (!name) {
      skipped.push({ partyId: record.partyId, reason: 'missing_name' });
      continue;
    }
    const type = TIN_TYPE_CODE[record.tinType];
    const key = `${type};${digits};${name.toUpperCase()}`;
    if (seen.has(key)) {
      skipped.push({ partyId: record.partyId, reason: 'duplicate' });
      continue;
    }
    const account = tinMatchAccountNumber(record.partyId);
    const owner = accountToParty[account];
    if (owner !== undefined && owner !== record.partyId) {
      skipped.push({ partyId: record.partyId, reason: 'account_collision' });
      continue;
    }
    seen.add(key);
    accountToParty[account] = record.partyId;
    lines.push(`${type};${digits};${name};${account}`);
  }

  const files: TinMatchFile[] = [];
  for (let offset = 0; offset < lines.length; offset += perFile) {
    const chunk = lines.slice(offset, offset + perFile);
    files.push({
      filename: `${prefix}-${String(files.length + 1).padStart(3, '0')}.txt`,
      content: `${chunk.join('\r\n')}\r\n`,
      recordCount: chunk.length,
    });
  }
  return { files, skipped, accountToParty };
}

// Results

export type TinMatchStatus = 'match' | 'mismatch' | 'not_issued' | 'invalid' | 'duplicate';

export interface TinMatchResult {
  /** The party id behind the account number (through `accountToParty`), else the account number itself; null when blank. */
  partyId: string | null;
  accountNumber: string;
  status: TinMatchStatus;
  /** The indicator the IRS returned, 0-8. */
  code: number;
  /** Which records matched when the TIN type was unknown (codes 6-8). */
  matchedAs?: 'ssn' | 'ein' | 'both';
  /** Last four digits of the TIN in the record. */
  tinLast4: string | null;
  /** 1-based line number in the results file. */
  line: number;
}

export interface TinMatchParseOptions {
  /** `accountToParty` from the build step. */
  accountToParty?: Record<string, string>;
}

export interface TinMatchParseResult {
  results: TinMatchResult[];
  /** Lines that could not be read, with their 1-based line numbers. */
  unreadable: Array<{ line: number; text: string }>;
}

const CODE_MEANING: Record<number, { status: TinMatchStatus; matchedAs?: 'ssn' | 'ein' | 'both' }> = {
  0: { status: 'match' },
  1: { status: 'invalid' }, // missing TIN or not 9 digits
  2: { status: 'not_issued' },
  3: { status: 'mismatch' },
  4: { status: 'invalid' }, // invalid request: alphas or special characters
  5: { status: 'duplicate' },
  6: { status: 'match', matchedAs: 'ssn' },
  7: { status: 'match', matchedAs: 'ein' },
  8: { status: 'match', matchedAs: 'both' },
};

/** Parses the results file the IRS returns for an upload. */
export function parseTinMatchingResults(text: string, options: TinMatchParseOptions = {}): TinMatchParseResult {
  const results: TinMatchResult[] = [];
  const unreadable: Array<{ line: number; text: string }> = [];

  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const delimiter = line.includes(';') ? ';' : ',';
    const fields = line.split(delimiter).map((field) => field.trim());
    const last = fields[fields.length - 1] ?? '';
    const code = /^[0-8]$/.test(last) ? Number(last) : null;
    const type = fields[0] ?? '';
    if (code === null || fields.length < 3 || !/^[123]$/.test(type)) {
      unreadable.push({ line: index + 1, text: line });
      return;
    }
    const tin = (fields[1] ?? '').replace(/\D/g, '');
    const account = fields.length >= 5 ? (fields[3] ?? '') : '';
    const meaning = CODE_MEANING[code]!;
    results.push({
      partyId: account ? (options.accountToParty?.[account] ?? account) : null,
      accountNumber: account,
      status: meaning.status,
      code,
      ...(meaning.matchedAs ? { matchedAs: meaning.matchedAs } : {}),
      tinLast4: tin.length >= 4 ? tin.slice(-4) : null,
      line: index + 1,
    });
  });

  return { results, unreadable };
}
