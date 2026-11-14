/**
 * Per-IP rate limits on the public browser routes (`/e`, `/r`, `/snap`), with
 * Cloudflare's Workers rate-limiting binding (`[[ratelimits]]` in
 * wrangler.toml; the limits are set there). The binding counts on a key we
 * choose: a short hash of the address, so the address itself is never passed
 * on, and nothing here is stored. A missing binding or an address-less request
 * (local dev) is not limited, and a failing binding lets the request through:
 * the limiter protects the collector, it must not take it down.
 */

import { warnOnce } from './warn';

async function key(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether this request is over the limit and should be answered 429. */
export async function rateLimited(limiter: RateLimit | undefined, ip: string): Promise<boolean> {
  if (!limiter || !ip) return false;
  try {
    const outcome = await limiter.limit({ key: await key(ip) });
    return !outcome.success;
  } catch (error) {
    warnOnce('rate-limit', `Rate limiter failed, not limiting: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
