/**
 * Coercion of raw CSV/Excel cell strings into typed values for the CRM importer.
 *
 * Kept standalone (no React / xlsx deps) so the rules can be unit-tested in
 * isolation and reused by the import dialog + custom-field mapping.
 */

export type ImportValueType = 'string' | 'number' | 'boolean';

/**
 * Coerce a non-empty cell string per `valueType`. Returns `undefined` when the
 * value should be skipped (e.g. an unparseable number), so callers can drop it
 * rather than send `NaN`.
 */
export function coerceScalar(value: string, valueType?: ImportValueType): unknown {
  if (valueType === 'number') {
    const n = Number(value.replace(/,/g, ''));
    return Number.isNaN(n) ? undefined : n;
  }
  if (valueType === 'boolean') {
    return /^(true|yes|y|1|x|✓)$/i.test(value.trim());
  }
  return value;
}
