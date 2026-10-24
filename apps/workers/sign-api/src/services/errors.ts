/**
 * Errors the WeldSign services throw for the routes to turn into responses
 * (`respondToSignError` in ../routes/envelopes/shared.ts).
 */

export type SignErrorKind = 'not_found' | 'conflict' | 'invalid';

export class SignError extends Error {
  constructor(
    readonly kind: SignErrorKind,
    message: string,
    /** For `not_found`: what was missing ("Envelope", "Document", …). */
    readonly resource?: string,
  ) {
    super(message);
    this.name = 'SignError';
  }
}

export const notFound = (resource: string, id: string) => new SignError('not_found', `${resource} ${id} not found`, resource);

/** Only a draft can be changed; everything after sending is fixed evidence. */
export const notADraft = () => new SignError('conflict', 'Only a draft can be changed');

export const invalid = (message: string) => new SignError('invalid', message);
