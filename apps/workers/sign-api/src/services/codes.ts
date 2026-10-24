/**
 * Identity codes for signing links: a 6-digit code emailed when the link is
 * opened (auth mode `email_code`), or the access code the sender shared
 * (`access_code`). Kept in KV under the link's token hash:
 *
 *   sign:code:<tokenHash>   the emailed code's SHA-256, 10 minutes
 *   sign:tries:<tokenHash>  wrong answers so far, 15 minutes
 *   sign:sent:<tokenHash>   last time a code was emailed (resend throttle), 1 minute
 *
 * Five wrong answers lock the link for 15 minutes.
 */

import { sha256Hex } from './hash';

export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_TRIES = 5;
export const LOCK_SECONDS = 15 * 60;
export const RESEND_AFTER_SECONDS = 60;

const codeKey = (tokenHash: string) => `sign:code:${tokenHash}`;
const triesKey = (tokenHash: string) => `sign:tries:${tokenHash}`;
const sentKey = (tokenHash: string) => `sign:sent:${tokenHash}`;

export function newEmailCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, '0');
}

/** Store a fresh code for this link; false when one was sent less than a minute ago. */
export async function issueEmailCode(kv: KVNamespace, tokenHash: string, code: string): Promise<boolean> {
  if (await kv.get(sentKey(tokenHash))) return false;
  await Promise.all([
    kv.put(codeKey(tokenHash), await sha256Hex(code), { expirationTtl: CODE_TTL_SECONDS }),
    kv.put(sentKey(tokenHash), '1', { expirationTtl: RESEND_AFTER_SECONDS }),
  ]);
  return true;
}

export async function isLocked(kv: KVNamespace, tokenHash: string): Promise<boolean> {
  return Number((await kv.get(triesKey(tokenHash))) ?? 0) >= MAX_TRIES;
}

export type CodeCheck = { ok: true } | { ok: false; locked: boolean; attemptsLeft: number };

/** Compare an answer with the expected hash and count a wrong one. */
export async function checkCode(kv: KVNamespace, tokenHash: string, expectedHash: string | null, answer: string): Promise<CodeCheck> {
  const tries = Number((await kv.get(triesKey(tokenHash))) ?? 0);
  if (tries >= MAX_TRIES) return { ok: false, locked: true, attemptsLeft: 0 };
  if (expectedHash && (await sha256Hex(answer.trim())) === expectedHash) {
    await Promise.all([kv.delete(triesKey(tokenHash)), kv.delete(codeKey(tokenHash))]);
    return { ok: true };
  }
  const next = tries + 1;
  await kv.put(triesKey(tokenHash), String(next), { expirationTtl: LOCK_SECONDS });
  return { ok: false, locked: next >= MAX_TRIES, attemptsLeft: Math.max(MAX_TRIES - next, 0) };
}

/** The emailed code's hash for this link, if one is still valid. */
export async function emailCodeHash(kv: KVNamespace, tokenHash: string): Promise<string | null> {
  return kv.get(codeKey(tokenHash));
}

/** `ann@example.com` → `a••@example.com`, to say where the code went. */
export function emailHint(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  return `${local[0]}${'•'.repeat(Math.min(Math.max(local.length - 1, 2), 6))}@${domain}`;
}
