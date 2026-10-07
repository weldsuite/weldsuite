/**
 * Stringifies an untyped value (workflow inputs, API payloads, filter maps,
 * custom-field values). Same output as `String()` for strings, numbers,
 * booleans, dates, null/undefined and arrays, but a plain object becomes JSON
 * instead of "[object Object]".
 *
 * Dependency-free so every runtime (workers, browser, React Native, Node
 * tools) can share the one copy.
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol' || typeof value === 'function') return value.toString();
  if (value instanceof Date) return value.toString();
  if (Array.isArray(value)) return value.map((item) => (item == null ? '' : asText(item))).join(',');
  try {
    return JSON.stringify(value, (_key, nested: unknown) => (typeof nested === 'bigint' ? nested.toString() : nested));
  } catch {
    // Circular structures cannot be serialised; fall back to String() rather than throw.
    return String(value);
  }
}
