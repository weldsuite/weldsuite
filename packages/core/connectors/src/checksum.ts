/**
 * Record change detection.
 *
 * Every synced record is hashed and compared against
 * `integration_entity_mappings.sync_checksum`; an unchanged record is skipped
 * rather than rewritten. This is what makes two things affordable:
 *
 *   - **Re-delivery.** A webhook replay or an un-advanced watermark re-reads
 *     records we already hold, and the checksum turns each one into a skip.
 *   - **Providers with no incremental filter.** A driver that cannot ask for
 *     "changed since X" full-scans instead, and only genuinely-changed records
 *     reach the database. Without this, every sweep would rewrite every row.
 */

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * Providers do not guarantee key order, so a plain `JSON.stringify` would
 * produce a different checksum for a byte-identical record and turn every
 * re-delivery into a pointless update.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * SHA-256 of a record, ignoring volatile envelope fields.
 *
 * `exclude` exists because some providers stamp every response with a value
 * that changes on each delivery — a cursor, an ETag, a `retrieved_at`. Hashing
 * those defeats the skip path entirely, so a driver declares them via
 * `ConnectorDriver.volatileFields` and they are dropped here.
 *
 * Only top-level keys are excluded; nested volatility has not been needed and
 * a deep path syntax would be guessing at a requirement.
 */
export async function recordChecksum(
  record: Record<string, unknown>,
  exclude: readonly string[] = [],
): Promise<string> {
  const payload =
    exclude.length === 0
      ? record
      : Object.fromEntries(Object.entries(record).filter(([k]) => !exclude.includes(k)));

  const encoded = new TextEncoder().encode(stableStringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
