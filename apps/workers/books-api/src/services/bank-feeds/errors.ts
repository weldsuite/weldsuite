import { FeedProviderError } from '@weldsuite/bank-feeds';

export type FeedServiceErrorCode = 'not_found' | 'bad_request' | 'conflict' | 'upstream' | 'unavailable';

/** A failure the caller can act on; the routes map `code` to an HTTP status. */
export class FeedServiceError extends Error {
  constructor(
    readonly code: FeedServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedServiceError';
  }
}

/** Provider messages carry the provider's error code and text, never credentials, so they are safe to show. */
export function translateProviderError(err: unknown): FeedServiceError | null {
  if (!(err instanceof FeedProviderError)) return null;
  switch (err.kind) {
    case 'not_configured':
      return new FeedServiceError('unavailable', err.message);
    case 'permanent':
    case 'unsupported':
    case 'reauth_required':
    case 'revoked':
      return new FeedServiceError('bad_request', err.message);
    default:
      return new FeedServiceError('upstream', err.message);
  }
}
