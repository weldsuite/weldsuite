/**
 * Building blocks for the public portals' passwordless sign-in (project
 * portal, help desk portal, HR portal): hashed tokens, uniformly random
 * one-time codes and small KV JSON helpers. Rate limits are NOT in KV (it has
 * no atomic increment): they live in ./portal-rate-limit and are re-exported
 * here.
 */

export {
  applyRateLimitHit,
  applyRateLimitRelease,
  consumeRateLimit,
  RATE_LIMIT_MAX,
  RATE_LIMIT_TTL_SECONDS,
  rateLimitKey,
  RateLimitCounter,
  releaseRateLimit,
  REQUEST_RATE_LIMIT_WORKSPACE_MAX,
  type PortalRateLimitEnv,
  type RateLimitCounterStore,
  type RateLimitCounterStub,
  type RateLimitNamespace,
  type RateLimitOutcome,
  type RateLimitState,
  type RateLimitVerdict,
} from './portal-rate-limit';

/** The KV binding the portal token helpers read and write. */
export interface PortalKvEnv {
  WORKSPACE_CACHE: KVNamespace;
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const OTP_MODULUS = 1_000_000;
const UINT32_VALUES = 0x1_0000_0000;
/**
 * Draws at or above this are discarded. 2^32 is not a multiple of 10^6, so
 * `draw % 10^6` would make the codes 000000-967295 slightly more likely than
 * the rest; accepting only draws below the largest multiple of 10^6 under 2^32
 * makes all 10^6 codes exactly equally likely. About 0.02% of draws are redrawn.
 */
export const OTP_REJECTION_LIMIT = UINT32_VALUES - (UINT32_VALUES % OTP_MODULUS);
/** Draws before giving up: (0.0002)^32 is zero in practice, only a broken RNG gets there. */
const OTP_MAX_DRAWS = 32;

/** Fills the array with random 32-bit values. Overridable for tests only. */
export type RandomFill = (buffer: Uint32Array) => void;

const cryptoFill: RandomFill = (buffer) => {
  crypto.getRandomValues(buffer);
};

/** A uniformly random 6-digit code (zero padded), by rejection sampling. */
export function randomOtp(fill: RandomFill = cryptoFill): string {
  const draw = new Uint32Array(1);
  for (let attempt = 0; attempt < OTP_MAX_DRAWS; attempt++) {
    fill(draw);
    const value = draw[0]!;
    if (value < OTP_REJECTION_LIMIT) return String(value % OTP_MODULUS).padStart(6, '0');
  }
  throw new Error('Random source did not produce a usable value');
}

export async function kvGetJson<T>(env: PortalKvEnv, key: string): Promise<T | null> {
  if (!env.WORKSPACE_CACHE?.get) return null;
  const value = await env.WORKSPACE_CACHE.get(key, 'json');
  return (value as T | null) ?? null;
}

export async function kvPutJson(env: PortalKvEnv, key: string, value: unknown, ttl: number): Promise<void> {
  if (!env.WORKSPACE_CACHE?.put) return;
  await env.WORKSPACE_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

export async function kvDelete(env: PortalKvEnv, key: string): Promise<void> {
  if (!env.WORKSPACE_CACHE?.delete) return;
  await env.WORKSPACE_CACHE.delete(key);
}
