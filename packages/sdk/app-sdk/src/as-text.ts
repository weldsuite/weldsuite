/**
 * Stringifies an untyped value (API payloads, request bodies, caught errors).
 * Same output as `String()` for strings, numbers, booleans, dates,
 * null/undefined and arrays, but a plain object becomes JSON instead of
 * "[object Object]".
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol' || typeof value === 'function') return value.toString();
  if (value instanceof Date) return value.toString();
  if (Array.isArray(value)) return value.map((item) => (item == null ? '' : asText(item))).join(',');
  return JSON.stringify(value);
}
