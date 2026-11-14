/**
 * Reading Basin values in panel-api's own statements (chunk manifests, the
 * erasure lookup, snapshot search). Same rules as the compiler's row readers
 * in `@weldsuite/panel-domain/query`: numbers may arrive as strings or
 * bigints, timestamps without a zone are UTC.
 */

export function numberOf(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** An ISO 8601 string from a Basin timestamp (string, Date or epoch millis); the input text when it is none. */
export function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const text = textOf(value);
  if (text === '') return '';
  const normalised = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}
