/**
 * KV helpers for the B2B commerce portal: magic-link / OTP challenges and
 * buyer sessions. Tokens are stored hashed (SHA-256 hex); only the buyer
 * ever sees the plaintext. Rate limits are NOT in KV (it has no atomic
 * increment): they live in ./portal-rate-limit and are re-exported here.
 */

export {
  applyRateLimitHit,
  consumeRateLimit,
  RATE_LIMIT_MAX,
  RATE_LIMIT_TTL_SECONDS,
  rateLimitKey,
  RateLimitCounter,
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

/** What {@link commercePortalOrigin} reads. */
export interface PortalOriginEnv {
  ENVIRONMENT: string;
  /**
   * Public origin of the B2B commerce portal (no trailing slash), used in
   * magic-link emails. Defaults: production `https://orders.weldsuite.org`,
   * test `https://orders-test.weldsuite.org`, otherwise `http://localhost:3021`.
   */
  COMMERCE_PORTAL_URL?: string;
}

export const OTP_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Wrong guesses a challenge survives before it is invalidated. */
export const MAX_VERIFY_ATTEMPTS = 8;
/** Verify calls per 15 minutes: per client IP, and per workspace across all IPs. */
export const VERIFY_RATE_LIMIT_IP_MAX = 20;
export const VERIFY_RATE_LIMIT_WORKSPACE_MAX = 200;

export interface PortalChallenge {
  tokenHash: string;
  otpHash: string;
  email: string;
  workspaceId: string;
  accessIds: string[];
  attempts: number;
}

export interface PortalSession {
  workspaceId: string;
  personId: string;
  companyId: string;
  partyId: string;
  accessId: string;
  email: string;
}

export interface PortalPicker {
  workspaceId: string;
  email: string;
  accessIds: string[];
}

export function commercePortalOrigin(env: PortalOriginEnv): string {
  if (env.COMMERCE_PORTAL_URL) return env.COMMERCE_PORTAL_URL.replace(/\/$/, '');
  if (env.ENVIRONMENT === 'production') return 'https://orders.weldsuite.org';
  if (env.ENVIRONMENT === 'test') return 'https://orders-test.weldsuite.org';
  return 'http://localhost:3021';
}

export function otpKvKey(workspaceId: string, email: string): string {
  return `cportal:otp:${workspaceId}:${email.trim().toLowerCase()}`;
}

export function sessionKvKey(tokenHash: string): string {
  return `cportal:sess:${tokenHash}`;
}

export function pickerKvKey(tokenHash: string): string {
  return `cportal:pick:${tokenHash}`;
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

/**
 * Store a challenge keyed by workspace + email. Only the magic-link token has
 * a reverse index (`cportal:tok:`): it carries 256 bits of entropy, so a
 * global key is safe. The 6-digit OTP deliberately has NO reverse index: the
 * buyer sends their email with it, so every wrong guess lands on a known
 * challenge and counts against {@link MAX_VERIFY_ATTEMPTS}.
 */
export async function storeChallenge(
  env: PortalKvEnv,
  challenge: PortalChallenge,
  email: string,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  await kvPutJson(env, otpKvKey(challenge.workspaceId, normalized), challenge, OTP_TTL_SECONDS);
  await kvPutJson(env, `cportal:tok:${challenge.tokenHash}`, { email: normalized }, OTP_TTL_SECONDS);
}

export async function deleteChallenge(env: PortalKvEnv, challenge: PortalChallenge): Promise<void> {
  await kvDelete(env, otpKvKey(challenge.workspaceId, challenge.email));
  await kvDelete(env, `cportal:tok:${challenge.tokenHash}`);
}
