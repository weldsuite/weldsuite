/**
 * Prospect validation looks up MX records over DNS-over-HTTPS (global `fetch`).
 * `stubDns()` answers those lookups without a network: every domain can receive
 * mail except the ones named in `noMx`. Returns the restore function.
 */

import { vi } from 'vitest';

export function stubDns(noMx: readonly string[] = ['nomx.example']): () => void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const name = new URL(String(input)).searchParams.get('name') ?? '';
    const body = noMx.includes(name)
      ? { Status: 3 }
      : { Status: 0, Answer: [{ name: `${name}.`, type: 15, TTL: 60, data: `10 mx.${name}.` }] };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/dns-json' } });
  });
  return () => vi.unstubAllGlobals();
}
