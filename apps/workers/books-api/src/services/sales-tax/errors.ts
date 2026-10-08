/**
 * Errors of the US sales tax document flow. Each carries an API code the UI
 * can act on; routes answer them through `salesTaxErrorResponse`.
 */

import type { Context } from 'hono';
import { SalesTaxEngineError } from '@weldsuite/books-domain/sales-tax';

export type SalesTaxDocumentErrorCode =
  | 'ADDRESS_REQUIRED'
  | 'TAX_ENGINE_UNAVAILABLE'
  | 'TAX_RATES_NOT_CONFIGURED'
  | 'USE_TAX_ENGINE_UNSUPPORTED'
  | 'CREDIT_LINE_NOT_ON_ORIGINAL'
  | 'TAX_NOT_CALCULATED'
  | 'TAX_COMMIT_NOT_APPLICABLE';

export class SalesTaxDocumentError extends Error {
  constructor(
    readonly code: SalesTaxDocumentErrorCode,
    message: string,
    readonly status: 400 | 409 | 503 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SalesTaxDocumentError';
  }
}

/** A setup object (agency, jurisdiction, zone, rule, certificate) the request can't create or change as asked. */
export class SalesTaxSetupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'SalesTaxSetupError';
  }
}

/** A finalize with no ship-to or bill-to state and ZIP on a US document that needs tax. */
export function addressRequired(): SalesTaxDocumentError {
  return new SalesTaxDocumentError(
    'ADDRESS_REQUIRED',
    'A ship-to (or bill-to) address with a state and ZIP code is required to calculate sales tax. Add it to the invoice before finalizing.',
  );
}

/**
 * The engine could not calculate. The draft keeps its last calculation and
 * can't be finalized: an engine failure never posts zero tax.
 */
export function engineUnavailable(err: SalesTaxEngineError): SalesTaxDocumentError {
  const retryable = err.code === 'unreachable' || err.code === 'rate_limited';
  return new SalesTaxDocumentError(
    'TAX_ENGINE_UNAVAILABLE',
    `The sales tax engine could not calculate tax: ${err.message}. The invoice was not posted.${retryable ? ' Try again in a moment.' : ''}`,
    retryable ? 503 : 400,
    { engineCode: err.code, retryable },
  );
}

export function salesTaxErrorResponse(c: Context, err: unknown): Response | undefined {
  if (err instanceof SalesTaxSetupError) {
    const code = err.status === 404 ? 'NOT_FOUND' : err.status === 409 ? 'CONFLICT' : 'BAD_REQUEST';
    return c.json({ error: { code, message: err.message } }, err.status);
  }
  if (err instanceof SalesTaxDocumentError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err instanceof SalesTaxEngineError) {
    const wrapped = engineUnavailable(err);
    return c.json({ error: { code: wrapped.code, message: wrapped.message, details: wrapped.details } }, wrapped.status);
  }
  return undefined;
}
