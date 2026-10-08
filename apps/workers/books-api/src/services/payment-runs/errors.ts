/**
 * A problem the caller can act on in the payment-run flow. Routes turn it
 * into `{ error: { code, message, details } }` with its HTTP status.
 */
export type PaymentRunErrorStatus = 400 | 403 | 404 | 409 | 422;

export class PaymentRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: PaymentRunErrorStatus = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PaymentRunError';
  }
}

export const notFound = (what: string, id?: string): PaymentRunError =>
  new PaymentRunError('NOT_FOUND', id ? `${what} with ID '${id}' not found` : `${what} not found`, 404);

export const badRequest = (code: string, message: string, details?: Record<string, unknown>): PaymentRunError =>
  new PaymentRunError(code, message, 400, details);
