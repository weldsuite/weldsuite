/**
 * Turns parsed CSV rows into prospect rows for `importProspects`: guesses
 * which column is which, applies the mapping, and counts what the server is
 * likely to leave out (consumer and role addresses are hints only: the
 * workspace's limits decide, the server checks again).
 */

import {
  isConsumerEmail,
  isRoleEmail,
  type ImportReachProspectsInput,
  type ReachImportReport,
} from '@weldsuite/app-api-client/schemas/reach';
import type { ParsedCsv } from './csv';

export const PROSPECT_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'companyName',
  'title',
  'timezone',
] as const;
export type ProspectField = (typeof PROSPECT_FIELDS)[number];

/** Column index per field, or `null` when the field is not in the file. */
export type ColumnMapping = Record<ProspectField, number | null>;

type ImportRow = ImportReachProspectsInput['rows'][number];

/** Header spellings (English and Dutch, lower-cased, without spaces or punctuation) per field. */
const ALIASES: Record<ProspectField, string[]> = {
  email: ['email', 'emailaddress', 'mail', 'emailadres', 'workemail', 'businessemail', 'epost'],
  firstName: ['firstname', 'first', 'givenname', 'voornaam', 'fname'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'achternaam', 'lname'],
  companyName: ['company', 'companyname', 'organization', 'organisation', 'bedrijf', 'bedrijfsnaam', 'employer', 'account'],
  title: ['title', 'jobtitle', 'position', 'role', 'functie', 'jobrole'],
  timezone: ['timezone', 'tz', 'tijdzone'],
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

/** Picks the first column whose header matches a field; a column is used for one field only. */
export function guessMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map(normalizeHeader);
  const taken = new Set<number>();
  const mapping = Object.fromEntries(PROSPECT_FIELDS.map((field) => [field, null])) as ColumnMapping;

  for (const field of PROSPECT_FIELDS) {
    const index = normalized.findIndex((header, i) => !taken.has(i) && ALIASES[field].includes(header));
    if (index !== -1) {
      mapping[field] = index;
      taken.add(index);
    }
  }
  return mapping;
}

/** Columns not mapped to a field, in file order: candidates for custom fields. */
export function unmappedColumns(headers: string[], mapping: ColumnMapping): number[] {
  const used = new Set(Object.values(mapping).filter((index): index is number => index !== null));
  return headers.map((_, index) => index).filter((index) => !used.has(index));
}

const CUSTOM_KEY_MAX = 64;
const CUSTOM_VALUE_MAX = 2000;
export const CUSTOM_FIELDS_MAX = 50;

/** A header as a custom field key a template can use (`{{key}}`): letters, digits, `_ . -`. */
export function customFieldKey(header: string): string {
  const key = trimUnderscores(header.trim().toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '_')).slice(
    0,
    CUSTOM_KEY_MAX,
  );
  return key || 'field';
}

function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '_') start += 1;
  while (end > start && value[end - 1] === '_') end -= 1;
  return value.slice(start, end);
}

/** Unique keys for the chosen columns: a repeated key gets `_2`, `_3`, … */
export function customFieldKeys(headers: string[], columns: number[]): Map<number, string> {
  const keys = new Map<number, string>();
  const used = new Set<string>();
  for (const column of columns) {
    const base = customFieldKey(headers[column] ?? '');
    let key = base;
    let n = 2;
    while (used.has(key)) {
      key = `${base.slice(0, CUSTOM_KEY_MAX - 6)}_${n}`;
      n += 1;
    }
    used.add(key);
    keys.set(column, key);
  }
  return keys;
}

/** One `@`, something before it, and a dotted domain after it: the server does the real check. */
export function looksLikeEmail(value: string): boolean {
  if (value.length > 320 || /\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

export interface PreparedImport {
  /** Rows to send: a usable address, once per address. */
  rows: ImportRow[];
  stats: {
    total: number;
    /** No address, or one that cannot be an address. Not sent. */
    invalid: number;
    /** An address that already appeared earlier in the file. Not sent. */
    duplicate: number;
    /** Sent, but the server leaves them out unless consumer addresses are enabled. */
    consumer: number;
    /** Sent, but the server leaves them out by default. */
    role: number;
  };
}

function cell(row: string[], index: number | null): string | undefined {
  if (index === null) return undefined;
  const value = row[index]?.trim();
  return value ? value : undefined;
}

/** Applies the mapping to every row. `customColumns` become custom fields under `keys`. */
export function prepareImport(
  parsed: ParsedCsv,
  mapping: ColumnMapping,
  customColumns: number[],
  keys: Map<number, string>,
): PreparedImport {
  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  const stats = { total: parsed.rows.length, invalid: 0, duplicate: 0, consumer: 0, role: 0 };

  for (const source of parsed.rows) {
    const email = cell(source, mapping.email)?.toLowerCase();
    if (!email || !looksLikeEmail(email)) {
      stats.invalid += 1;
      continue;
    }
    if (seen.has(email)) {
      stats.duplicate += 1;
      continue;
    }
    seen.add(email);
    if (isConsumerEmail(email)) stats.consumer += 1;
    else if (isRoleEmail(email)) stats.role += 1;

    const customFields: Record<string, string> = {};
    for (const column of customColumns) {
      const key = keys.get(column);
      const value = cell(source, column);
      if (!key || value === undefined || Object.keys(customFields).length >= CUSTOM_FIELDS_MAX) continue;
      customFields[key] = value.slice(0, CUSTOM_VALUE_MAX);
    }

    rows.push({
      email,
      firstName: cell(source, mapping.firstName)?.slice(0, 100),
      lastName: cell(source, mapping.lastName)?.slice(0, 100),
      companyName: cell(source, mapping.companyName)?.slice(0, 200),
      title: cell(source, mapping.title)?.slice(0, 200),
      timezone: cell(source, mapping.timezone)?.slice(0, 64),
      customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
    });
  }

  return { rows, stats };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

/** One report for an import sent in several requests, plus the rows that were never sent. */
export function mergeReports(
  reports: ReachImportReport[],
  local: { invalid: number; duplicate: number },
): ReachImportReport {
  const skipped = new Map<ReachImportReport['skipped'][number]['reason'], number>();
  const add = (reason: ReachImportReport['skipped'][number]['reason'], count: number) => {
    if (count > 0) skipped.set(reason, (skipped.get(reason) ?? 0) + count);
  };

  let created = 0;
  let updated = 0;
  let listId: string | null = null;
  for (const report of reports) {
    created += report.created;
    updated += report.updated;
    listId = report.listId ?? listId;
    for (const entry of report.skipped) add(entry.reason, entry.count);
  }
  add('invalid_row', local.invalid);
  add('duplicate', local.duplicate);

  return {
    listId,
    created,
    updated,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
  };
}
