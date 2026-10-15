/**
 * Maps the one send error type (`PersonalMailSendError`) onto response shapes,
 * for every route that sends mail: compose, reply, forward and the
 * unsubscribe mail.
 *
 * Besides the account and plan-limit errors, a send can be refused by the
 * outbound guard (`SENDING_LIMITED`, `FIRST_CONTACT_LIMITED`, ...) or by
 * Cloudflare itself. Statuses follow `outboundDenialStatus` (403 staff or
 * ownership, 422 the message itself, 429 a window is full); `Retry-After` is
 * set whenever a retry can succeed. docs/plans/weldmail-outbound-abuse.md.
 */

import type { Context } from 'hono';
import {
  OUTBOUND_DENIAL_CODES,
  outboundDenialStatus,
  type OutboundDenialCode,
  type OutboundDenialDetails,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { error } from './response';
import type { PersonalMailSendError } from '../services/mail-send';

/** Seconds to wait after Cloudflare's own rate limit. */
const PROVIDER_RATE_LIMIT_RETRY_SECONDS = 60;

/** Whole seconds until an ISO time, at least 1; null when it is missing or not a date. */
function secondsUntil(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(1, Math.ceil((at - Date.now()) / 1000));
}

export function isOutboundDenialCode(code: string): code is OutboundDenialCode {
  return (OUTBOUND_DENIAL_CODES as readonly string[]).includes(code);
}

/** The guard refused. A refused sender address carries no details: whose it is is not the caller's to learn. */
function denied(c: Context, err: PersonalMailSendError, code: OutboundDenialCode) {
  const details = err.details as OutboundDenialDetails | undefined;
  const retryAfter = secondsUntil(details?.retryAfter);
  if (retryAfter) c.header('Retry-After', String(retryAfter));
  return c.json(
    {
      error: {
        code,
        message: err.message,
        ...(details && code !== 'SENDER_NOT_OWNED' ? { details } : {}),
      },
    },
    outboundDenialStatus(code),
  );
}

export function mapSendError(c: Context, err: PersonalMailSendError) {
  switch (err.code) {
    case 'ACCOUNT_NOT_FOUND':
      return error.notFound(c, 'Mail account');
    case 'MESSAGE_NOT_FOUND':
      return error.notFound(c, 'Message');
    case 'DAILY_LIMIT_REACHED':
      return error.planLimit(c, err.message, err.details);
    case 'NO_RECIPIENTS':
      return error.badRequest(c, err.message);
    case 'DELIVERY_FAILED':
      return error.unavailable(c, err.message);
    case 'PROVIDER_RATE_LIMITED':
      c.header('Retry-After', String(PROVIDER_RATE_LIMIT_RETRY_SECONDS));
      return c.json({ error: { code: err.code, message: err.message } }, 429);
    case 'PROVIDER_DAILY_LIMIT':
      return c.json({ error: { code: err.code, message: err.message } }, 503);
    case 'PARTIALLY_SENT':
      // Some recipients got the message before the send failed; details say who.
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, 502);
    default:
      if (isOutboundDenialCode(err.code)) return denied(c, err, err.code);
      return error.internal(c, err.message);
  }
}
