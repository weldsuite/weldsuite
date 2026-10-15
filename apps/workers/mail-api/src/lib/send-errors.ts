/**
 * One mapping from `MailSendError` to an HTTP response for every mail-api
 * route that sends (compose, reply, forward, scheduled send-now).
 *
 * The outbound guard's codes (docs/plans/weldmail-outbound-abuse.md) keep
 * their own code in the body so clients can explain them; `Retry-After` is set
 * when the limit clears on its own.
 */

import type { Context } from 'hono';
import {
  OUTBOUND_DENIAL_CODES,
  outboundDenialStatus,
  type OutboundDenialCode,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { MailSendError } from '@weldsuite/mail-domain/send';
import { error } from '@weldsuite/worker-kit/response';

const DENIAL_CODES: ReadonlySet<string> = new Set(OUTBOUND_DENIAL_CODES);

function isDenialCode(code: string): code is OutboundDenialCode {
  return DENIAL_CODES.has(code);
}

function retryAfterSeconds(details: unknown): number | null {
  const at = (details as { retryAfter?: unknown } | undefined)?.retryAfter;
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at) - Date.now();
  return Number.isNaN(ms) ? null : Math.max(1, Math.ceil(ms / 1000));
}

/**
 * The response for a failed send. `notFound` names the resource a
 * `ACCOUNT_NOT_FOUND` is about ("Mail account", "Message").
 */
export function sendErrorResponse(c: Context, err: MailSendError, notFound: { resource: string; id?: string }) {
  const body = { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
  const retry = retryAfterSeconds(err.details);
  if (retry !== null) c.header('Retry-After', String(retry));

  if (isDenialCode(err.code)) return c.json(body, outboundDenialStatus(err.code));
  switch (err.code) {
    case 'ACCOUNT_NOT_FOUND':
    case 'DRAFT_NOT_FOUND':
      return error.notFound(c, notFound.resource, notFound.id);
    case 'FORBIDDEN':
      return error.forbidden(c, err.message);
    case 'INVALID_RECIPIENTS':
    case 'ATTACHMENT_NOT_IN_WORKSPACE':
    case 'ATTACHMENT_NOT_IN_STORAGE':
    case 'EMAIL_TOO_LARGE':
      return error.badRequest(c, err.message, err.details);
    case 'SENDER_DOMAIN_NOT_VERIFIED':
      return c.json(body, 422);
    case 'DAILY_LIMIT_REACHED':
    case 'PROVIDER_RATE_LIMITED':
      return c.json(body, 429);
    case 'PARTIALLY_SENT':
      return c.json(body, 502);
    case 'PROVIDER_DAILY_LIMIT':
    case 'STORAGE_BINDING_MISSING':
    case 'SEND_BINDING_MISSING':
      return c.json(body, 503);
  }
}
