/**
 * Automatic replies: out-of-office notices, vacation responders, mailing-list
 * and bulk mail. They are recorded but never treated as a person answering.
 *
 * Headers first (RFC 3834 `Auto-Submitted`, the vendor `X-Auto*` family,
 * `Precedence`, Exchange's `X-Auto-Response-Suppress`), then subject patterns
 * in English, Dutch, German and French for responders that set no header.
 */

import { normalizeSubject } from '@weldsuite/reach-domain/inbound/text';

export interface AutoReplyDetection {
  auto: boolean;
  /** Which signal fired, for logs. */
  reason: string | null;
}

/** Subjects that only an auto-responder writes, anywhere in the subject. */
const SUBJECT_ANYWHERE = new RegExp(
  [
    'out[ -]of[ -]the[ -]office',
    'out[ -]of[ -]office',
    'automatic reply',
    'automatisch antwoord',
    'automatisch bericht',
    'afwezigheidsmelding',
    'automatische antwort',
    'abwesenheitsnotiz',
    'abwesenheitsmeldung',
    'r[ée]ponse automatique',
    'absence du bureau',
    'respuesta autom[aá]tica',
    'risposta automatica',
  ].join('|'),
  'i',
);

/** Prefixes that start an auto-responder's subject. */
const SUBJECT_PREFIX = /^(?:auto[ -]?reply|auto[ -]?response|autoreply|autorespond|afwezig(?:heid)?|abwesen(?:d|heit)|ooo)\b/i;

const AUTO_PRECEDENCE = new Set(['auto_reply', 'auto-reply', 'bulk', 'junk', 'list']);

export function detectAutoReply(headers: Record<string, string>, subject: string): AutoReplyDetection {
  const autoSubmitted = headers['auto-submitted']?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return { auto: true, reason: `auto-submitted:${autoSubmitted}` };

  for (const key of ['x-autoreply', 'x-autorespond', 'x-autoresponder', 'x-auto-reply']) {
    if (key in headers) return { auto: true, reason: key };
  }

  const precedence = headers['precedence']?.trim().toLowerCase();
  if (precedence && AUTO_PRECEDENCE.has(precedence)) return { auto: true, reason: `precedence:${precedence}` };

  const suppress = headers['x-auto-response-suppress']?.toLowerCase();
  if (suppress && (suppress.includes('oof') || suppress.trim() === 'all')) {
    return { auto: true, reason: 'x-auto-response-suppress' };
  }

  const bare = normalizeSubject(subject);
  if (SUBJECT_PREFIX.test(bare) || SUBJECT_ANYWHERE.test(subject)) return { auto: true, reason: 'subject' };

  return { auto: false, reason: null };
}

/**
 * Newsletter and mailing-list mail that landed in the mailbox without being
 * an answer to anything we sent. Only meaningful for mail that matched no
 * outbound message: a real prospect reply may carry such headers by accident.
 */
export function looksLikeBulk(headers: Record<string, string>): boolean {
  return 'list-unsubscribe' in headers || 'list-id' in headers || headers['x-spam-flag']?.trim().toLowerCase() === 'yes';
}
