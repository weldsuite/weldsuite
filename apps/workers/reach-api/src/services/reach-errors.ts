/**
 * Domain errors of the WeldReach account services (access, settings, billing,
 * domains, mailboxes) and their mapping to the standard error envelope.
 *
 * Services throw `ReachServiceError` (or let a Mailpool / billing-worker / DNS
 * error through) and each router turns it into
 * `{ error: { code, message, details? } }` with `app.onError(reachErrorHandler)`.
 * A sub-app's `onError` wins over the parent's, so the handler also owns the
 * generic 500.
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { DnsLookupError } from '../lib/dns';
import { PaymentMethodRequiredError, ReachBillingError } from '../lib/billing';
import { MailpoolError, MailpoolNotConfiguredError } from '../lib/mailpool/errors';

export type ReachErrorStatus = 400 | 402 | 403 | 404 | 409 | 422 | 502 | 503;

export class ReachServiceError extends Error {
  readonly status: ReachErrorStatus;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: ReachErrorStatus, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ReachServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface MappedError {
  status: ReachErrorStatus | 500;
  code: string;
  message: string;
  details?: unknown;
}

/** The HTTP shape of any error the account services can throw; null for unknown errors. */
export function mapReachError(err: unknown): MappedError | null {
  if (err instanceof ReachServiceError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof PaymentMethodRequiredError) {
    return { status: 402, code: 'PAYMENT_METHOD_REQUIRED', message: err.message };
  }
  if (err instanceof ReachBillingError) {
    return { status: 502, code: 'UPSTREAM_ERROR', message: 'Billing service error. Try again in a moment.' };
  }
  if (err instanceof MailpoolNotConfiguredError) {
    return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Outreach mailbox provider is not configured.' };
  }
  if (err instanceof MailpoolError) {
    return {
      status: 502,
      code: 'UPSTREAM_ERROR',
      message: 'The mailbox provider could not complete the request. Try again in a moment.',
    };
  }
  if (err instanceof DnsLookupError) {
    return { status: 503, code: 'DNS_CHECK_FAILED', message: 'DNS could not be checked right now. Try again in a moment.' };
  }
  return null;
}

/** `app.onError(reachErrorHandler)` for the routers of this worker's account surface. */
export function reachErrorHandler(err: Error, c: Context): Response {
  if (err instanceof HTTPException) return err.getResponse();
  const mapped = mapReachError(err);
  if (mapped) {
    if (mapped.status >= 500) console.error(`[reach] ${mapped.code}:`, err);
    return c.json({ error: { code: mapped.code, message: mapped.message, details: mapped.details } }, mapped.status);
  }
  console.error('[reach] unhandled error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500);
}
