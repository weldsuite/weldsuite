function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** JSON with object keys sorted, so equal specs hash equal whatever order a client wrote them in. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareKeys(a, b));
  const body = entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',');
  return `{${body}}`;
}

/**
 * KV key for a cached query result: `panel:q:<workspace>:<project>:<sha256 of the parsed spec>`.
 * The workspace and project are in the key, so one workspace can never read another's entry.
 */
export async function specCacheKey(workspaceId: string, projectId: string, spec: unknown): Promise<string> {
  const data = new TextEncoder().encode(stableStringify(spec));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `panel:q:${workspaceId}:${projectId}:${hex}`;
}
