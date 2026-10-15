/**
 * Errors of the Brazilian fiscal document services, and how a route answers
 * them: a refusal the user can act on is a 400/404/409 with the reason, a
 * provider rejection carries Focus' own message and itemised errors, and a
 * provider that is down is a 502.
 */

import type { Context } from 'hono';
import { error } from '@weldsuite/worker-kit/response';
import { FiscalProviderError } from './focus-client';
import { BrPayloadError } from './payload';

export class FiscalDocumentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FiscalDocumentError';
  }
}

/** The response for an error the fiscal services throw, or undefined for anything else. */
export function fiscalErrorResponse(c: Context, err: unknown): Response | undefined {
  if (err instanceof FiscalDocumentError) {
    if (err.status === 404) return error.notFound(c, err.message);
    if (err.status === 409) return error.conflict(c, err.message, err.details);
    return error.badRequest(c, err.message, err.details);
  }
  if (err instanceof BrPayloadError) {
    return error.badRequest(c, err.message, { missing: err.missing });
  }
  if (err instanceof FiscalProviderError) {
    if (err.isRejection || err.isAuthFailure) {
      // A rejected token is the entity's problem (wrong token), not an auth failure of this request.
      return error.badRequest(c, err.detail, { provider: 'focus_nfe', codigo: err.codigo, erros: err.erros });
    }
    return error.badGateway(c, err.detail);
  }
  return undefined;
}
