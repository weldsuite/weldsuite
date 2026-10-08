export type FeedErrorKind =
  /** Credentials rejected (our keys, not the user's bank login). */
  | 'auth'
  /** The user must go through the bank login again. */
  | 'reauth_required'
  /** The user (or the bank) ended the consent. */
  | 'revoked'
  | 'rate_limit'
  | 'transient'
  | 'permanent'
  | 'not_configured'
  | 'unsupported'
  /** Plaid: data changed between pages, restart the loop from the first cursor. */
  | 'mutation_during_pagination';

/**
 * A failed provider call. The message carries the provider's error code and
 * text, never request bodies, so it is safe to log and to show.
 */
export class FeedProviderError extends Error {
  readonly kind: FeedErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    provider: string,
    kind: FeedErrorKind,
    message: string,
    extra: { status?: number; code?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'FeedProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

/** A webhook whose signature, age or body hash did not check out. Answer 401. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}
