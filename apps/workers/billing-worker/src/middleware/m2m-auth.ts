/**
 * Clerk machine-to-machine (M2M) authentication for the operator-facing HTTP
 * routes (`/api/internal/backfill/*`, `/api/internal/pricing/*`).
 *
 * A bearer token is verified with Clerk, and the verification RESULT (which
 * machine minted the token, its scopes, when it expires) is what we keep:
 *
 *  - On success the caller is exposed on the context as `c.get('m2m')`, so a
 *    route can tell which machine called instead of "somebody with a token".
 *  - The verification is cached in KV for at most `VERIFY_CACHE_TTL_SECONDS`
 *    (KV's minimum), never past the token's own expiry, and the expiry is
 *    checked again on every cache hit. A revoked opaque token therefore stops
 *    working within that TTL, not five minutes.
 *  - `M2M_ALLOWED_MACHINE_IDS` (comma separated Clerk machine ids, `mch_...`)
 *    names the machines that may call these routes. Clerk verifies any token
 *    minted by a machine of the instance, so without an allowlist every machine
 *    of the instance is trusted; unset keeps that behaviour and warns once.
 *
 * Never log the token, a prefix of it or its length. The only token-derived
 * value that is logged is the first 8 hex characters of its SHA-256.
 */

import { createMiddleware } from 'hono/factory';
import { createClerkClient } from '@clerk/backend';
import type { Env } from '../index';

/** KV's minimum `expirationTtl`; also the longest a revocation can go unnoticed. */
const VERIFY_CACHE_TTL_SECONDS = 60;
const VERIFY_CACHE_PREFIX = 'm2m:v2:';

/** The caller of an M2M-protected route, as verified by Clerk. */
export interface M2mPrincipal {
  /** Clerk machine id (`mch_...`) that minted the token (the token's subject). */
  machineId: string;
  /** Clerk machine ids the issuing machine may call (the token's `scopes`). */
  scopes: string[];
  /** Token expiry as epoch milliseconds, null for a token that does not expire. */
  expiresAt: number | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by `m2mAuth()` once the bearer token verified and the machine is allowed. */
    m2m: M2mPrincipal;
  }
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Clerk reports token timestamps in milliseconds; anything below 1e11 can only
 * be seconds (1e11 ms is 1973, 1e11 s is the year 5138), so scale it.
 */
function toEpochMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? value * 1000 : value;
}

function isPrincipal(value: unknown): value is M2mPrincipal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.machineId === 'string' &&
    v.machineId.length > 0 &&
    Array.isArray(v.scopes) &&
    v.scopes.every((s) => typeof s === 'string') &&
    (v.expiresAt === null || typeof v.expiresAt === 'number')
  );
}

/** Parse `M2M_ALLOWED_MACHINE_IDS`: comma or whitespace separated, empty entries dropped. */
export function parseAllowedMachineIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** `M2M_ALLOWED_MACHINE_IDS` is optional; it is read through a narrow view of the bindings. */
function readAllowedMachineIds(env: Env): string[] {
  return parseAllowedMachineIds((env as Env & { M2M_ALLOWED_MACHINE_IDS?: string }).M2M_ALLOWED_MACHINE_IDS);
}

let warnedOpenAllowlist = false;

/**
 * `true` when the machine may call these routes. With no allowlist every
 * machine of the Clerk instance passes (the behaviour before the allowlist
 * existed), and one warning per isolate says so.
 */
function isMachineAllowed(env: Env, machineId: string): boolean {
  const allowed = readAllowedMachineIds(env);
  if (allowed.length === 0) {
    if (!warnedOpenAllowlist) {
      warnedOpenAllowlist = true;
      console.warn(
        '[M2M Auth] M2M_ALLOWED_MACHINE_IDS is not set: every machine of the Clerk instance may call these routes. Set it to the machine ids that should.',
      );
    }
    return true;
  }
  return allowed.includes(machineId);
}

/** Seconds a verification may be cached for, or 0 when it must not be (it would outlive the token). */
function cacheTtlSeconds(expiresAt: number | null, now: number): number {
  if (expiresAt === null) return VERIFY_CACHE_TTL_SECONDS;
  const secondsLeft = Math.floor((expiresAt - now) / 1000);
  return secondsLeft >= VERIFY_CACHE_TTL_SECONDS ? VERIFY_CACHE_TTL_SECONDS : 0;
}

async function readCachedPrincipal(kv: KVNamespace, cacheKey: string): Promise<M2mPrincipal | null> {
  try {
    const cached = await kv.get(cacheKey, 'json');
    return isPrincipal(cached) ? cached : null;
  } catch {
    return null;
  }
}

/** Verify the token with Clerk. Null (logged, never the token) when it does not authenticate. */
async function verifyWithClerk(env: Env, token: string, tokenHash: string, now: number): Promise<M2mPrincipal | null> {
  const ref = tokenHash.slice(0, 8);
  try {
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    const verified = await clerk.m2m.verify({ token, machineSecretKey: env.CLERK_MACHINE_SECRET_KEY });

    const expiresAt = toEpochMs(verified.expiration);
    const expired = verified.expired || (expiresAt !== null && expiresAt <= now);
    if (verified.revoked || expired || !verified.subject) {
      console.warn(`[M2M Auth] Token rejected (ref ${ref}): revoked, expired or without a subject`);
      return null;
    }
    return { machineId: verified.subject, scopes: verified.scopes ?? [], expiresAt };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
    console.warn(`[M2M Auth] Token verification failed (ref ${ref}): ${reason}`);
    return null;
  }
}

/** Cache a verified principal; a failing write must never turn a verified token into a 401. */
function cachePrincipal(
  kv: KVNamespace,
  ctx: ExecutionContext,
  cacheKey: string,
  principal: M2mPrincipal,
  now: number,
): void {
  const ttl = cacheTtlSeconds(principal.expiresAt, now);
  if (ttl <= 0) return;
  ctx.waitUntil(kv.put(cacheKey, JSON.stringify(principal), { expirationTtl: ttl }).catch(() => undefined));
}

export const m2mAuth = () => {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      if (c.env.ENVIRONMENT !== 'production') console.warn('[M2M Auth] Missing or invalid Authorization header');
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const tokenHash = await hashToken(token);
    const cacheKey = `${VERIFY_CACHE_PREFIX}${tokenHash}`;
    const now = Date.now();

    let principal = await readCachedPrincipal(c.env.WORKSPACE_CACHE, cacheKey);

    // A cache hit still honours the token's own expiry.
    if (principal && principal.expiresAt !== null && principal.expiresAt <= now) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!principal) {
      principal = await verifyWithClerk(c.env, token, tokenHash, now);
      if (!principal) return c.json({ error: 'Unauthorized' }, 401);
      cachePrincipal(c.env.WORKSPACE_CACHE, c.executionCtx, cacheKey, principal, now);
    }

    // Authorisation runs on every request, hit or miss: the allowlist can change
    // while a verification is cached. A genuine token of a refused machine is
    // cached too, so probing costs one Clerk call a minute.
    if (!isMachineAllowed(c.env, principal.machineId)) {
      console.warn(`[M2M Auth] Machine ${principal.machineId} is not allowed to call this worker`);
      return c.json({ error: 'Forbidden' }, 403);
    }

    c.set('m2m', principal);
    await next();
  });
};
