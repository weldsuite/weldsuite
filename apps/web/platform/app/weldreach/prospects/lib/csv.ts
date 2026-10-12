/**
 * CSV reading for the prospect import. The file is parsed in the browser
 * (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes, CRLF),
 * tolerating a byte-order mark and the semicolon or tab separators Excel
 * writes in some locales.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

const DELIMITERS = [',', ';', '\t'] as const;

/** The separator used most often on the first line, outside quotes. */
export function detectDelimiter(text: string): string {
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

/** The record and field being read, and whether the reader is inside quotes. */
interface Reader {
  records: string[][];
  record: string[];
  field: string;
  quoted: boolean;
}

function endField(reader: Reader): void {
  reader.record.push(reader.field);
  reader.field = '';
}

function endRecord(reader: Reader): void {
  endField(reader);
  reader.records.push(reader.record);
  reader.record = [];
}

/** Reads one character inside quotes; returns the index of the last character used. */
function readQuoted(text: string, index: number, reader: Reader): number {
  const char = text.charAt(index);
  if (char !== '"') {
    reader.field += char;
    return index;
  }
  if (text.charAt(index + 1) === '"') {
    reader.field += '"';
    return index + 1;
  }
  reader.quoted = false;
  return index;
}

/** Reads one character outside quotes; returns the index of the last character used. */
function readPlain(text: string, index: number, reader: Reader, delimiter: string): number {
  const char = text.charAt(index);
  if (char === '"' && reader.field === '') {
    reader.quoted = true;
  } else if (char === delimiter) {
    endField(reader);
  } else if (char === '\n' || char === '\r') {
    endRecord(reader);
    // CRLF is one line break.
    return char === '\r' && text.charAt(index + 1) === '\n' ? index + 1 : index;
  } else {
    reader.field += char;
  }
  return index;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const reader: Reader = { records: [], record: [], field: '', quoted: false };

  let index = 0;
  while (index < text.length) {
    const lastUsed = reader.quoted
      ? readQuoted(text, index, reader)
      : readPlain(text, index, reader, delimiter);
    index = lastUsed + 1;
  }
  if (reader.field !== '' || reader.record.length > 0) endRecord(reader);

  // Blank lines carry nothing; the first remaining line is the header.
  const nonEmpty = reader.records.filter((row) => row.some((value) => value.trim() !== ''));
  const [headers = [], ...rows] = nonEmpty;
  return { headers: headers.map((header) => header.trim()), rows };
}
