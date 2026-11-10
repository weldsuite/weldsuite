/**
 * Bot checks behind one port (ADR FORMS-005): Cloudflare Turnstile on Global,
 * ALTCHA (self-hosted proof of work, no third party) on Kubernetes, or none.
 * The portal renders the widget; forms-api verifies the token when a session
 * starts and before an email code is sent.
 *
 * ALTCHA: `createAltchaChallenge` hands out `{ algorithm, challenge, salt,
 * signature, maxnumber }`, where `challenge = SHA-256(salt + secretNumber)` and
 * `signature = HMAC-SHA-256(key, challenge)`. The browser finds the number
 * and sends the base64 JSON `{ ..., number }` back; `verifyAltcha` checks the
 * hash, the signature and the expiry in the salt, and a solved challenge works
 * once (a marker in the cache), so a solution cannot be replayed.
 */

import { base64Url, hmacHex, safeEqual, sha256Hex } from '../lib/crypto';
import type { Env } from '../types';
import type { BotCheckProvider } from '@weldsuite/app-api-client/schemas/weldforms';

export const ALTCHA_MAX_NUMBER = 50_000;
const ALTCHA_TTL_SECONDS = 10 * 60;

export function botCheckProvider(env: Pick<Env, 'BOT_CHECK_PROVIDER'>): BotCheckProvider {
  const raw = (env.BOT_CHECK_PROVIDER ?? 'none').toLowerCase();
  return raw === 'turnstile' || raw === 'altcha' ? raw : 'none';
}

export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

export async function createAltchaChallenge(env: Pick<Env, 'ALTCHA_HMAC_KEY'>, now = Date.now()): Promise<AltchaChallenge | null> {
  if (!env.ALTCHA_HMAC_KEY) return null;
  const salt = `${base64Url(crypto.getRandomValues(new Uint8Array(12)))}?expires=${Math.floor(now / 1000) + ALTCHA_TTL_SECONDS}`;
  const number = crypto.getRandomValues(new Uint32Array(1))[0]! % ALTCHA_MAX_NUMBER;
  const challenge = await sha256Hex(`${salt}${number}`);
  return { algorithm: 'SHA-256', challenge, salt, signature: await hmacHex(env.ALTCHA_HMAC_KEY, challenge), maxnumber: ALTCHA_MAX_NUMBER };
}

interface AltchaPayload {
  algorithm: string;
  challenge: string;
  number: number;
  salt: string;
  signature: string;
}

function parseAltcha(token: string): AltchaPayload | null {
  try {
    const raw = JSON.parse(atob(token.replaceAll('-', '+').replaceAll('_', '/'))) as Partial<AltchaPayload>;
    if (raw.algorithm !== 'SHA-256' || typeof raw.challenge !== 'string' || typeof raw.salt !== 'string' || typeof raw.signature !== 'string') return null;
    if (typeof raw.number !== 'number' || !Number.isInteger(raw.number) || raw.number < 0) return null;
    return raw as AltchaPayload;
  } catch {
    return null;
  }
}

export async function verifyAltcha(env: Pick<Env, 'ALTCHA_HMAC_KEY' | 'WORKSPACE_CACHE'>, token: string, now = Date.now()): Promise<boolean> {
  if (!env.ALTCHA_HMAC_KEY) return false;
  const payload = parseAltcha(token);
  if (!payload) return false;
  const expires = Number(new URLSearchParams(payload.salt.split('?')[1] ?? '').get('expires'));
  if (!Number.isFinite(expires) || expires * 1000 < now) return false;
  if (!safeEqual(await sha256Hex(`${payload.salt}${payload.number}`), payload.challenge)) return false;
  if (!safeEqual(await hmacHex(env.ALTCHA_HMAC_KEY, payload.challenge), payload.signature)) return false;
  const used = `forms:altcha:${payload.challenge}`;
  if (await env.WORKSPACE_CACHE.get(used)) return false;
  await env.WORKSPACE_CACHE.put(used, '1', { expirationTtl: ALTCHA_TTL_SECONDS + 60 });
  return true;
}

export async function verifyTurnstile(env: Pick<Env, 'TURNSTILE_SECRET_KEY'>, token: string, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    if (!res.ok) return false;
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch (err) {
    console.error('[forms-api] turnstile verification failed:', err);
    return false;
  }
}

/** True when the token passes the configured check (always true for `none`). */
export async function passesBotCheck(env: Env, token: string | undefined, ip: string | null): Promise<boolean> {
  const provider = botCheckProvider(env);
  if (provider === 'none') return true;
  if (!token) return false;
  return provider === 'turnstile' ? verifyTurnstile(env, token, ip) : verifyAltcha(env, token);
}
