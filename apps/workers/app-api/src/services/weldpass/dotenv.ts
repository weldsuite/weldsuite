/**
 * .env parsing and rendering.
 *
 * Importing an existing `.env` is how a vault gets populated the first time, so
 * this handles the shapes people actually paste: `export` prefixes, quoted
 * values with escapes, `#` comments, blank lines, and CRLF.
 */

/** A valid environment variable name for every target WeldPass syncs to. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidSecretKey(key: string): boolean {
  return KEY_PATTERN.test(key) && key.length <= 255;
}

export interface ParsedDotenv {
  values: Record<string, string>;
  /** Lines that could not be read as `KEY=value`, with their 1-based number. */
  skipped: Array<{ line: number; reason: string }>;
}

export function parseDotenv(input: string): ParsedDotenv {
  const values: Record<string, string> = {};
  const skipped: ParsedDotenv['skipped'] = [];

  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) {
      skipped.push({ line: i + 1, reason: 'No "=" found' });
      continue;
    }

    const key = withoutExport.slice(0, eq).trim();
    if (!isValidSecretKey(key)) {
      skipped.push({ line: i + 1, reason: `"${key.slice(0, 40)}" is not a valid variable name` });
      continue;
    }

    values[key] = unquote(withoutExport.slice(eq + 1).trim());
  }

  return { values, skipped };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];

    if (first === '"' && last === '"') {
      // Double quotes are the only form where escapes are expanded, matching
      // dotenv itself. An unterminated escape at the end stays literal.
      return value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    if (first === "'" && last === "'") {
      return value.slice(1, -1);
    }
  }

  // Unquoted values end at an inline comment, but only one preceded by space —
  // `pass#word` is a password, ` # note` is a comment.
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/** Render values as a `.env` file. Quoted whenever anything could be misread. */
export function renderDotenv(values: Record<string, string>): string {
  return (
    Object.keys(values)
      .sort()
      .map((key) => `${key}=${quoteIfNeeded(values[key])}`)
      .join('\n') + '\n'
  );
}

function quoteIfNeeded(value: string): string {
  if (value === '') return '""';
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}"`;
}
