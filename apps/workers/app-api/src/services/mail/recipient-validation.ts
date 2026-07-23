/**
 * Recipient validation for outbound mail.
 *
 *   1. RFC-ish format check via `z.string().email()`
 *   2. DNS MX lookup via Cloudflare DNS-over-HTTPS, cached in
 *      `WORKSPACE_CACHE` KV under an `mx:` prefix.
 *
 * Domain reachability is global, not workspace-scoped, but co-locating
 * with other ephemeral worker caches keeps the binding count low.
 */

import { z } from 'zod';
import type { Env } from '../../types';

const emailSchema = z.string().email();

const MX_CACHE_PREFIX = 'mx:';
const POSITIVE_TTL_SECONDS = 60 * 60 * 24; // 24h
const NEGATIVE_TTL_SECONDS = 60 * 60; // 1h
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 3_000;

export interface RecipientValidationOk {
  ok: true;
}
export interface RecipientValidationFail {
  ok: false;
  invalidFormat: string[];
  unreachableDomains: string[];
}
export type RecipientValidationResult = RecipientValidationOk | RecipientValidationFail;

export function extractDomains(addresses: string[]): string[] {
  const domains = new Set<string>();
  for (const addr of addresses) {
    if (!emailSchema.safeParse(addr).success) continue;
    const at = addr.lastIndexOf('@');
    if (at === -1) continue;
    const domain = addr.slice(at + 1).toLowerCase().trim();
    if (domain) domains.add(domain);
  }
  return [...domains];
}

interface DohAnswer {
  Status?: number;
  Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
}

/**
 * Single DoH JSON query. Returns true if at least one usable record exists.
 * Per RFC 5321 §5.1, a domain with no MX but an A/AAAA record is still
 * reachable for SMTP — we honor that fallback only after MX comes up empty,
 * to keep the happy path one round-trip.
 */
async function dohQuery(domain: string, type: 'MX' | 'A'): Promise<boolean> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=${type}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) return false;
    const json = (await resp.json()) as DohAnswer;
    if (json.Status !== 0) return false;
    return Array.isArray(json.Answer) && json.Answer.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupMx(domain: string, env: Env): Promise<boolean> {
  const key = `${MX_CACHE_PREFIX}${domain}`;
  const kv = env.WORKSPACE_CACHE;

  if (kv) {
    try {
      const cached = await kv.get(key);
      if (cached === '1') return true;
      if (cached === '0') return false;
    } catch {
      // fall through to live query
    }
  }

  let reachable = await dohQuery(domain, 'MX');
  if (!reachable) {
    reachable = await dohQuery(domain, 'A');
  }

  if (kv) {
    try {
      await kv.put(key, reachable ? '1' : '0', {
        expirationTtl: reachable ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS,
      });
    } catch {
      // best-effort
    }
  }

  return reachable;
}

export async function validateRecipients(
  to: string[],
  cc: string[] | undefined,
  bcc: string[] | undefined,
  env: Env,
  opts?: { skipMx?: boolean },
): Promise<RecipientValidationResult> {
  const all = [...to, ...(cc ?? []), ...(bcc ?? [])];

  const invalidFormat = all.filter((addr) => !emailSchema.safeParse(addr).success);
  const validAddresses = all.filter((addr) => emailSchema.safeParse(addr).success);

  // `skipMx` keeps the deterministic RFC format check but bypasses the live
  // DNS-over-HTTPS MX lookup. Used by the test-fixtures dry-run send path so
  // API tests don't depend on real domains having MX records (or on the
  // network at all). Never set on the production send route.
  const unreachableDomains = opts?.skipMx
    ? []
    : (
        await Promise.all(
          extractDomains(validAddresses).map(
            async (d) => [d, await lookupMx(d, env)] as const,
          ),
        )
      )
        .filter(([, ok]) => !ok)
        .map(([d]) => d);

  if (invalidFormat.length === 0 && unreachableDomains.length === 0) {
    return { ok: true };
  }
  return { ok: false, invalidFormat, unreachableDomains };
}
