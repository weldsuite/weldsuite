/**
 * Webhook verification helpers, one per scheme the providers use:
 *  - HMAC-SHA256 over `t.payload` with a timestamp tolerance (Stripe, also Teller's shape);
 *  - an ES256 JWT with a fetched verification key (Plaid), the key cached in KV;
 *  - an RS512 JWT with a key from Ibanity's webhooks API (Ponto), cached the same way.
 * All comparisons are constant time. Everything runs on WebCrypto, so it works on Workers.
 */

import { WebhookVerificationError } from './errors';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  defaultFetch,
  fromBase64Url,
  requestJson,
  utf8,
  type FetchLike,
} from './http';
import { sha256Hex } from './normalize';
import type { KeyCache } from './types';

// ── Primitives ─────────────────────────────────────────────────────────────

/** Constant-time string comparison (length differences do not short-circuit). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = utf8(a);
  const y = utf8(b);
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, utf8(message));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Stripe-style HMAC ──────────────────────────────────────────────────────

export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** `t=<unix>,v1=<hex>` as Stripe sends it; for tests and fixtures. */
export async function buildStripeSignatureHeader(payload: string, secret: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${payload}`)}`;
}

/**
 * Verify a `Stripe-Signature` header: HMAC-SHA256 of `${t}.${payload}`, any
 * `v1` candidate may match, the timestamp must be within the tolerance.
 */
export async function verifyStripeSignature(args: {
  payload: string;
  header: string | null | undefined;
  secret: string;
  toleranceSeconds?: number;
  /** ms since the epoch; defaults to the current time. */
  now?: number;
}): Promise<boolean> {
  if (!args.header || !args.secret) return false;
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of args.header.split(',')) {
    const [name, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (name === 't') timestamp = asNumber(value);
    else if (name === 'v1' && value) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return false;

  const nowSeconds = Math.floor((args.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > (args.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS)) return false;

  const expected = await hmacSha256Hex(args.secret, `${timestamp}.${args.payload}`);
  let ok = false;
  for (const candidate of candidates) ok = timingSafeEqual(candidate, expected) || ok;
  return ok;
}

// ── Plaid ES256 JWT ────────────────────────────────────────────────────────

export const PLAID_WEBHOOK_MAX_AGE_SECONDS = 300;

/** The JWK `/webhook_verification_key/get` returns. */
export interface PlaidWebhookKey {
  alg?: string;
  crv: string;
  kid?: string;
  kty: string;
  use?: string;
  x: string;
  y: string;
  created_at?: number;
  expired_at?: number | null;
}

export type PlaidKeyResolver = (kid: string) => Promise<PlaidWebhookKey>;

function decodeJwtPart(part: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(fromBase64Url(part))));
  } catch {
    throw new WebhookVerificationError('Malformed webhook token');
  }
}

/**
 * Verify Plaid's `Plaid-Verification` header against the raw request body:
 * ES256 JWT, key looked up by `kid`, `iat` at most five minutes old, and
 * `request_body_sha256` equal to the SHA-256 of the body. Throws
 * `WebhookVerificationError` on any failure.
 */
export async function verifyPlaidWebhook(args: {
  body: string;
  header: string | null | undefined;
  getKey: PlaidKeyResolver;
  maxAgeSeconds?: number;
  /** ms since the epoch; defaults to the current time. */
  now?: number;
}): Promise<void> {
  if (!args.header) throw new WebhookVerificationError('Missing Plaid-Verification header');
  const parts = args.header.split('.');
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (parts.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) {
    throw new WebhookVerificationError('Malformed webhook token');
  }

  const header = decodeJwtPart(encodedHeader);
  const kid = asString(header.kid);
  if (header.alg !== 'ES256' || !kid) throw new WebhookVerificationError('Unsupported webhook token');

  let jwk: PlaidWebhookKey;
  try {
    jwk = await args.getKey(kid);
  } catch {
    throw new WebhookVerificationError('Webhook verification key unavailable');
  }
  const nowSeconds = Math.floor((args.now ?? Date.now()) / 1000);
  if (typeof jwk.expired_at === 'number' && jwk.expired_at < nowSeconds) {
    throw new WebhookVerificationError('Webhook verification key expired');
  }

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      fromBase64Url(encodedSignature),
      utf8(`${encodedHeader}.${encodedClaims}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new WebhookVerificationError('Invalid webhook signature');

  const claims = decodeJwtPart(encodedClaims);
  const iat = asNumber(claims.iat);
  const maxAge = args.maxAgeSeconds ?? PLAID_WEBHOOK_MAX_AGE_SECONDS;
  if (iat === null || nowSeconds - iat > maxAge || iat - nowSeconds > maxAge) {
    throw new WebhookVerificationError('Webhook token expired');
  }

  const bodyHash = await sha256Hex(args.body);
  const claimedHash = asString(claims.request_body_sha256);
  if (!claimedHash || !timingSafeEqual(bodyHash, claimedHash.toLowerCase())) {
    throw new WebhookVerificationError('Webhook body does not match its token');
  }
}

export const PLAID_KEY_CACHE_TTL_SECONDS = 3600;

/** In-memory `KeyCache` for tests and workers without KV (per isolate, TTL honoured). */
export function memoryKeyCache(now: () => number = Date.now): KeyCache {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options) {
      entries.set(key, { value, expiresAt: now() + (options?.expirationTtl ?? 3600) * 1000 });
    },
  };
}

/**
 * Resolve Plaid webhook verification keys by `kid`: cache first (KV when the
 * worker has it), else `/webhook_verification_key/get`.
 */
export function createPlaidKeyResolver(args: {
  baseUrl: string;
  clientId: string;
  secret: string;
  cache?: KeyCache;
  fetchImpl?: FetchLike;
}): PlaidKeyResolver {
  const fetchImpl = args.fetchImpl ?? defaultFetch();
  const cache = args.cache ?? sharedMemoryCache;
  return async (kid) => {
    const cacheKey = `bank-feeds:plaid-wvk:${args.baseUrl}:${kid}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as PlaidWebhookKey;
      } catch {
        // fall through to a fresh fetch
      }
    }
    const response = await requestJson(`${args.baseUrl}/webhook_verification_key/get`, {
      provider: 'plaid',
      fetchImpl,
      json: { client_id: args.clientId, secret: args.secret, key_id: kid },
    });
    const key = asRecord(response.key);
    const resolved: PlaidWebhookKey = {
      alg: asString(key.alg) ?? undefined,
      crv: asString(key.crv) ?? 'P-256',
      kid: asString(key.kid) ?? kid,
      kty: asString(key.kty) ?? 'EC',
      use: asString(key.use) ?? undefined,
      x: asString(key.x) ?? '',
      y: asString(key.y) ?? '',
      created_at: asNumber(key.created_at) ?? undefined,
      expired_at: asNumber(key.expired_at),
    };
    await cache.put(cacheKey, JSON.stringify(resolved), { expirationTtl: PLAID_KEY_CACHE_TTL_SECONDS });
    return resolved;
  };
}

const sharedMemoryCache = memoryKeyCache();

// ── Ibanity RS512 JWT (Ponto) ──────────────────────────────────────────────

/** Ibanity allows 30 seconds of clock drift on `exp` and `iat` (its Ruby client's tolerance). */
export const IBANITY_WEBHOOK_TOLERANCE_SECONDS = 30;
export const IBANITY_ISSUER = 'https://api.ibanity.com';
/** Ibanity's webhooks API; called with the application's mTLS certificate, which picks the sandbox's or the live keys. */
export const IBANITY_WEBHOOK_KEYS_URL = 'https://api.ibanity.com/webhooks/keys';
/** Ibanity allows caching its keys for an hour, and advertises a new one two hours before it signs with it. */
export const IBANITY_KEY_CACHE_TTL_SECONDS = 3600;

/** An RSA signing key from `/webhooks/keys` (a JWK). */
export interface IbanityWebhookKey {
  e: string;
  kid: string;
  kty: string;
  n: string;
}

export type IbanityKeyResolver = (kid: string) => Promise<IbanityWebhookKey>;

/** Base64 (standard, padded) of the body's SHA-512, as the `digest` claim carries it. */
export async function sha512Base64(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', utf8(body)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Verify an Ibanity webhook (Ponto Connect) against the raw request body: the
 * `Signature` header is an RS512 JWT (always RS512, so no downgrade), its key
 * looked up by `kid`; `iss` is Ibanity, `aud` the application's id, `exp` not
 * passed and `iat` not in the future (30 seconds' leeway), and `digest` the
 * body's SHA-512. Throws `WebhookVerificationError` on any failure.
 */
export async function verifyIbanityWebhook(args: {
  body: string;
  header: string | null | undefined;
  /** The application's id in Isabel's developer portal. */
  applicationId: string;
  getKey: IbanityKeyResolver;
  toleranceSeconds?: number;
  /** ms since the epoch; defaults to the current time. */
  now?: number;
}): Promise<void> {
  if (!args.header) throw new WebhookVerificationError('Missing Signature header');
  const parts = args.header.split('.');
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (parts.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) {
    throw new WebhookVerificationError('Malformed webhook token');
  }

  const header = decodeJwtPart(encodedHeader);
  const kid = asString(header.kid);
  if (header.alg !== 'RS512' || !kid) throw new WebhookVerificationError('Unsupported webhook token');

  let jwk: IbanityWebhookKey;
  try {
    jwk = await args.getKey(kid);
  } catch {
    throw new WebhookVerificationError('Webhook verification key unavailable');
  }

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      // Ibanity pads its base64url; JWK import wants it bare.
      { kty: 'RSA', n: jwk.n.replace(/=+$/, ''), e: jwk.e.replace(/=+$/, ''), ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(encodedSignature), utf8(`${encodedHeader}.${encodedClaims}`));
  } catch {
    valid = false;
  }
  if (!valid) throw new WebhookVerificationError('Invalid webhook signature');

  const claims = decodeJwtPart(encodedClaims);
  if (claims.iss !== IBANITY_ISSUER) throw new WebhookVerificationError('Webhook token from another issuer');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((aud) => aud === args.applicationId)) throw new WebhookVerificationError('Webhook token for another application');

  const nowSeconds = Math.floor((args.now ?? Date.now()) / 1000);
  const tolerance = args.toleranceSeconds ?? IBANITY_WEBHOOK_TOLERANCE_SECONDS;
  const exp = asNumber(claims.exp);
  const iat = asNumber(claims.iat);
  if (exp === null || exp + tolerance < nowSeconds) throw new WebhookVerificationError('Webhook token expired');
  if (iat === null || iat > nowSeconds + tolerance) throw new WebhookVerificationError('Webhook token issued in the future');

  const digest = asString(claims.digest);
  if (!digest || !timingSafeEqual(await sha512Base64(args.body), digest)) {
    throw new WebhookVerificationError('Webhook body does not match its token');
  }
}

/**
 * Resolve Ibanity's webhook keys by `kid`: cache first (KV when the worker has
 * it), else `/webhooks/keys` with the application's certificate (`fetchImpl`).
 */
export function createIbanityKeyResolver(args: {
  /** Keeps a sandbox and a live application's keys apart in a shared cache. */
  applicationId: string;
  cache?: KeyCache;
  fetchImpl?: FetchLike;
  keysUrl?: string;
}): IbanityKeyResolver {
  const fetchImpl = args.fetchImpl ?? defaultFetch();
  const cache = args.cache ?? sharedMemoryCache;
  return async (kid) => {
    const cacheKey = `bank-feeds:ibanity-wk:${args.applicationId}:${kid}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as IbanityWebhookKey;
      } catch {
        // fall through to a fresh fetch
      }
    }
    const response = await requestJson(args.keysUrl ?? IBANITY_WEBHOOK_KEYS_URL, {
      provider: 'ponto',
      fetchImpl,
      headers: { Accept: 'application/vnd.api+json' },
    });
    const key = asArray(response.keys)
      .map(asRecord)
      .find((k) => asString(k.kid) === kid && (asString(k.use) ?? 'sig') === 'sig');
    if (!key) throw new WebhookVerificationError('Unknown webhook verification key');
    const resolved: IbanityWebhookKey = { e: asString(key.e) ?? '', kid, kty: asString(key.kty) ?? 'RSA', n: asString(key.n) ?? '' };
    await cache.put(cacheKey, JSON.stringify(resolved), { expirationTtl: IBANITY_KEY_CACHE_TTL_SECONDS });
    return resolved;
  };
}
