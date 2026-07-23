/**
 * Typed errors thrown by email providers. Consumers `instanceof`-check these
 * to decide whether to retry, surface to the user, or escalate.
 */

export class EmailProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

/**
 * Thrown by `send()` when the recipient must complete a provider-side
 * verification step (e.g. Cloudflare Email Routing destination-address
 * confirmation). The caller should:
 *  1. Persist the message in `pending_verification` state.
 *  2. Surface the pending state to the user.
 *  3. Retry the send once `verifiedAt` is observed (out-of-band poll, or
 *     webhook from the provider).
 */
export class PendingVerificationError extends EmailProviderError {
  constructor(
    public readonly recipient: string,
    provider: string,
    public readonly verificationSentAt: Date = new Date(),
  ) {
    super(`Recipient ${recipient} requires verification on provider "${provider}"`, provider);
    this.name = 'PendingVerificationError';
  }
}

/** Provider is missing required configuration (binding/secret). */
export class ProviderConfigError extends EmailProviderError {
  constructor(provider: string, missing: string) {
    super(`Provider "${provider}" missing config: ${missing}`, provider);
    this.name = 'ProviderConfigError';
  }
}

/** Provider returned a transient failure — caller should retry with backoff. */
export class TransientProviderError extends EmailProviderError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause);
    this.name = 'TransientProviderError';
  }
}

/** Provider rejected the request permanently — do not retry. */
export class PermanentProviderError extends EmailProviderError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause);
    this.name = 'PermanentProviderError';
  }
}
