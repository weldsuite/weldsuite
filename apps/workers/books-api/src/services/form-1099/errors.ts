export type Form1099ErrorKind = 'bad_request' | 'not_found' | 'conflict' | 'unavailable';

/** A problem the caller can act on; routes turn it into the matching error response. */
export class Form1099Error extends Error {
  constructor(
    readonly kind: Form1099ErrorKind,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'Form1099Error';
  }
}
