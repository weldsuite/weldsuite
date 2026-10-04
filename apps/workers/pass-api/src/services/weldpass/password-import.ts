/**
 * CSV import from other password managers.
 *
 * LastPass, NordPass, 1Password, Bitwarden and Chrome all export a CSV with a
 * header row, and they mostly disagree only on what the columns are called. So
 * the columns are resolved by name against a list of synonyms, and the format
 * matters only for the few quirks a column name cannot express (LastPass
 * hides secure notes behind the URL "http://sn"; NordPass and Bitwarden carry
 * a `type` column).
 *
 * Pure: text in, items out. The route seals and stores what this returns.
 */

import {
  itemInputSchema,
  hostOf,
  type WeldPassImportFormat,
  type WeldPassItemInput,
} from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { parseTotp } from './totp';

export const MAX_IMPORT_ITEMS = 2000;

export type DetectedFormat = Exclude<WeldPassImportFormat, 'auto'> | 'generic';

export interface ImportNote {
  /** 1-based line of the record in the file, counting the header as line 1. */
  line: number;
  reason: string;
}

export interface ParsedImport {
  format: DetectedFormat;
  documents: WeldPassItemInput[];
  /** Rows that were not imported. */
  skipped: ImportNote[];
  /** Rows that were imported with something left out. */
  warnings: ImportNote[];
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

interface CsvRecord {
  line: number;
  cells: string[];
}

/**
 * RFC 4180: quoted fields, doubled quotes, and line breaks inside quotes —
 * which a secure note almost always has.
 */
export function parseCsv(text: string): CsvRecord[] {
  const input = text.replace(/^﻿/, '');
  const records: CsvRecord[] = [];

  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(cell);
    // A blank line is not a record.
    if (cells.length > 1 || cells[0] !== '') records.push({ line: recordLine, cells });
    cells = [];
    cell = '';
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') line++;
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      cell += char;
    }
  }
  if (cell !== '' || cells.length > 0) endRecord();

  return records;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const COLUMNS = {
  title: ['name', 'title', 'account', 'item name'],
  url: ['url', 'login_uri', 'website', 'web site', 'uri', 'login url'],
  username: ['username', 'login_username', 'login', 'user', 'email', 'login name'],
  password: ['password', 'login_password'],
  totp: ['totp', 'otpauth', 'login_totp', 'otp', 'two factor', 'authenticator'],
  notes: ['notes', 'note', 'extra', 'comments'],
  type: ['type'],
  cardholder: ['cardholdername', 'cardholder'],
  cardNumber: ['cardnumber', 'card number'],
  cvc: ['cvc', 'cvv'],
  expiry: ['expirydate', 'expiry', 'expiration'],
} as const;

type Column = keyof typeof COLUMNS;

function detectFormat(headers: string[]): DetectedFormat {
  const has = (name: string) => headers.includes(name);
  if (has('login_uri') || has('login_password')) return 'bitwarden';
  if (has('grouping') && has('extra')) return 'lastpass';
  if (has('cardholdername') || has('additional_urls')) return 'nordpass';
  if (has('otpauth')) return '1password';
  if (has('name') && has('url') && has('username') && has('password')) return 'chrome';
  return 'generic';
}

// ---------------------------------------------------------------------------
// Rows → items
// ---------------------------------------------------------------------------

export function parseImport(text: string, format: WeldPassImportFormat = 'auto'): ParsedImport {
  const records = parseCsv(text);
  if (records.length === 0) throw new ImportError('That file is empty.');

  const headers = records[0].cells.map((header) => header.trim().toLowerCase());
  const index = {} as Record<Column, number>;
  for (const column of Object.keys(COLUMNS) as Column[]) {
    index[column] = headers.findIndex((header) =>
      (COLUMNS[column] as readonly string[]).includes(header),
    );
  }

  if (index.password === -1 && index.notes === -1) {
    throw new ImportError(
      'No password or notes column found. Export a CSV from your password manager and try again.',
    );
  }

  const detected = format === 'auto' ? detectFormat(headers) : format;
  const result: ParsedImport = { format: detected, documents: [], skipped: [], warnings: [] };

  for (const record of records.slice(1)) {
    const get = (column: Column) =>
      index[column] === -1 ? '' : (record.cells[index[column]] ?? '').trim();

    if (result.documents.length >= MAX_IMPORT_ITEMS) {
      result.skipped.push({
        line: record.line,
        reason: `Only the first ${MAX_IMPORT_ITEMS} items are imported at a time.`,
      });
      continue;
    }

    const kind = classify(detected, get);
    if (kind === 'unsupported') {
      result.skipped.push({ line: record.line, reason: 'This kind of item is not supported.' });
      continue;
    }

    let candidate: unknown;
    if (kind === 'card') {
      candidate = {
        type: 'card',
        title: get('title') || get('cardholder') || 'Card',
        fields: {
          cardholder: get('cardholder'),
          number: get('cardNumber'),
          expiry: get('expiry'),
          cvc: get('cvc'),
          notes: get('notes'),
        },
      };
    } else if (kind === 'note') {
      if (!get('notes') && !get('title')) continue;
      candidate = {
        type: 'note',
        title: get('title') || 'Note',
        fields: { content: get('notes') },
      };
    } else {
      const url = get('url');
      const username = get('username');
      const password = index.password === -1 ? '' : (record.cells[index.password] ?? '');
      if (!username && !password && !url) continue;

      let totp = get('totp');
      if (totp) {
        try {
          parseTotp(totp);
        } catch {
          totp = '';
          result.warnings.push({
            line: record.line,
            reason: 'The two-factor secret could not be read and was left out.',
          });
        }
      }

      candidate = {
        type: 'login',
        title: get('title') || hostOf(url) || username || 'Login',
        url: url || null,
        fields: { username, password, totp, notes: get('notes') },
      };
    }

    const parsed = itemInputSchema.safeParse(candidate);
    if (parsed.success) {
      result.documents.push(parsed.data);
    } else {
      const issue = parsed.error.issues[0];
      result.skipped.push({
        line: record.line,
        reason: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid row.',
      });
    }
  }

  return result;
}

function classify(
  format: DetectedFormat,
  get: (column: Column) => string,
): 'login' | 'note' | 'card' | 'unsupported' {
  const type = get('type').toLowerCase();

  if (format === 'nordpass') {
    if (type === 'credit_card') return 'card';
    if (type === 'note') return 'note';
    if (type === 'identity' || type === 'folder') return 'unsupported';
    return 'login';
  }

  if (format === 'bitwarden') {
    if (type === 'note') return 'note';
    if (type === 'card' || type === 'identity') return 'unsupported';
    return 'login';
  }

  // LastPass exports a secure note as a login whose URL is the literal "http://sn".
  if (format === 'lastpass' && get('url') === 'http://sn') return 'note';

  if (get('cardNumber')) return 'card';
  return 'login';
}
