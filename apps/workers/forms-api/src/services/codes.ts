/**
 * Email codes for verified-email forms (docs/plans/weldforms.md, "Respondent
 * modes"): a 6-digit code, valid 10 minutes, 5 wrong tries then the address is
 * locked for 15 minutes, as WeldSign.
 *
 *   forms:code:<formId>:<emailHash>   the emailed code's keyed hash, 10 minutes (KV)
 *   forms:sent:<formId>:<emailHash>   last time a code went out (resend throttle), 1 minute (KV)
 *
 * Wrong answers are counted by the form's `FormCounters` Durable Object, not KV:
 * KV has no atomic increment, so parallel `/verify` calls would each read the
 * same count and all get a guess before the lock landed. The stored form of a
 * code is an HMAC bound to the form and address, so a short code cannot be
 * brute-forced from a copy of the cache.
 */

import { resolveEmailLocale, sendSystemEmail, type EmailBrand } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import { FORM_LIMITS } from '@weldsuite/app-api-client/schemas/weldforms';
import { hmacHex, safeEqual } from '../lib/crypto';
import type { FormCountersPort } from '../lib/counters';
import { FormsError } from '../lib/errors';
import type { Env } from '../types';
import type { PublicCacheEntry } from './public-cache';
import { sessionSecret } from './sessions';
import { reserveOutboundMail, settleOutboundMail } from './mail';

export const RESEND_AFTER_SECONDS = 60;

const normalise = (email: string) => email.trim().toLowerCase();
const emailHash = (env: Env, formId: string, email: string) => hmacHex(sessionSecret(env), `forms-email:${formId}:${normalise(email)}`);
const codeKey = (formId: string, hash: string) => `forms:code:${formId}:${hash}`;
const sentKey = (formId: string, hash: string) => `forms:sent:${formId}:${hash}`;
const storedCode = (env: Env, formId: string, email: string, code: string) => hmacHex(sessionSecret(env), `forms-code:${formId}:${normalise(email)}:${code}`);

export function newEmailCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, '0');
}

/**
 * Stores a fresh code and emails it. 429 `RATE_LIMITED` when one went out less
 * than a minute ago, 423-style `LOCKED` (429) while the address is locked.
 */
export async function sendCode(env: Env, counters: FormCountersPort, entry: PublicCacheEntry, email: string, clerkOrgId: string): Promise<{ expiresInSeconds: number }> {
  const hash = await emailHash(env, entry.formId, email);
  if ((await counters.tries(`code:${hash}`)) >= FORM_LIMITS.codeMaxAttempts) {
    throw new FormsError(429, 'LOCKED', 'Too many wrong codes. Try again later.', { retryAfterSeconds: FORM_LIMITS.codeLockSeconds });
  }
  if (await env.WORKSPACE_CACHE.get(sentKey(entry.formId, hash))) {
    throw new FormsError(429, 'RATE_LIMITED', 'A code was just sent. Wait a minute before asking for another.', { retryAfterSeconds: RESEND_AFTER_SECONDS });
  }
  // Anyone can ask for a code to any address, so it counts against the workspace like other outbound mail (source `forms`).
  const reservation = await reserveOutboundMail(env, null, clerkOrgId, { to: [email.trim()], subjectLine: entry.title });
  if (reservation === 'refused') throw new FormsError(503, 'EMAIL_UNAVAILABLE', 'This form cannot send emails right now. Try again later.');
  const code = newEmailCode();
  await Promise.all([
    env.WORKSPACE_CACHE.put(codeKey(entry.formId, hash), await storedCode(env, entry.formId, email, code), { expirationTtl: FORM_LIMITS.codeTtlSeconds }),
    env.WORKSPACE_CACHE.put(sentKey(entry.formId, hash), '1', { expirationTtl: RESEND_AFTER_SECONDS }),
  ]);
  const transport = workerTransport(env);
  if (!transport) {
    console.warn('[forms-api/codes] no email transport configured; code not sent');
    await settleOutboundMail(env, null, reservation, [], 1);
  } else {
    const brand: EmailBrand = { kind: 'workspace', name: entry.branding.workspaceName, logoUrl: entry.branding.logoUrl };
    try {
      await sendSystemEmail(transport, {
        template: 'forms.code',
        props: { title: entry.title, code, expiresInMinutes: FORM_LIMITS.codeTtlSeconds / 60 },
        to: email.trim(),
        brand,
        locale: resolveEmailLocale(entry.definition?.presentation.language),
      });
    } catch (err) {
      console.error('[forms-api/codes] sending the code failed:', err);
      await settleOutboundMail(env, null, reservation, [], 1);
      throw new FormsError(502, 'EMAIL_FAILED', 'The code could not be sent. Try again.');
    }
    await settleOutboundMail(env, null, reservation, [email.trim()], 1);
  }
  return { expiresInSeconds: FORM_LIMITS.codeTtlSeconds };
}

/**
 * Checks an answer: 400 `INVALID_CODE` with `details.attemptsLeft`, 429
 * `LOCKED` once five are wrong. Only the counter decides, so a correct code
 * sent while the address is locked is refused too.
 */
export async function checkCode(env: Env, counters: FormCountersPort, formId: string, email: string, code: string): Promise<void> {
  const hash = await emailHash(env, formId, email);
  const expected = await env.WORKSPACE_CACHE.get(codeKey(formId, hash));
  const match = expected !== null && safeEqual(await storedCode(env, formId, email, code), expected);
  const result = await counters.attempt(`code:${hash}`, match);
  if (result.ok) {
    await env.WORKSPACE_CACHE.delete(codeKey(formId, hash));
    return;
  }
  if (result.locked) throw new FormsError(429, 'LOCKED', 'Too many wrong codes. Try again later.', { retryAfterSeconds: FORM_LIMITS.codeLockSeconds });
  throw new FormsError(400, 'INVALID_CODE', 'That code is not right.', { attemptsLeft: result.attemptsLeft });
}
