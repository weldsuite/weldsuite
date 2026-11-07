/**
 * Coercion of raw CSV/Excel cell strings into typed values for the CRM importer.
 *
 * Kept standalone (no React / xlsx deps) so the rules can be unit-tested in
 * isolation and reused by the import dialog + custom-field mapping.
 */

export type ImportValueType = 'string' | 'number' | 'boolean' | 'address';

const ADDRESS_KEYS = [
  'line1',
  'line2',
  'street',
  'houseNumber',
  'postalCode',
  'city',
  'state',
  'province',
  'country',
] as const;

/**
 * A postal address cell. The app's own CSV/Excel export writes the grid's
 * Primary Address column as a JSON object (`{"city":"Amsterdam","country":"NL"}`),
 * which is read back field by field (empty parts dropped). Anything else is
 * free text and is kept whole as the first address line so nothing is lost.
 */
export function parseAddressCell(value: string): Record<string, string> | undefined {
  const text = value.trim();
  if (!text) return undefined;

  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const source = parsed as Record<string, unknown>;
        const address: Record<string, string> = {};
        for (const key of ADDRESS_KEYS) {
          const part = source[key];
          if ((typeof part === 'string' || typeof part === 'number') && String(part).trim()) {
            address[key] = String(part).trim();
          }
        }
        return Object.keys(address).length > 0 ? address : undefined;
      }
    } catch {
      // Not JSON after all (a street that starts with "{"): free text below.
    }
  }
  return { line1: text };
}

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
  if (valueType === 'address') {
    return parseAddressCell(value);
  }
  return value;
}
