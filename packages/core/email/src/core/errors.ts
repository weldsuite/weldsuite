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

/**
 * Provider returned a transient failure — caller should retry with backoff.
 *
 * A send fanned out per recipient can fail halfway: `sentRecipients` lists the
 * envelopes that already went out (and `messageId` the message they carry), so
 * the caller can record what was sent instead of retrying everyone.
 */
export class TransientProviderError extends EmailProviderError {
  constructor(
    message: string,
    provider: string,
    cause?: unknown,
    public readonly sentRecipients: string[] = [],
    public readonly messageId?: string,
  ) {
    super(message, provider, cause);
    this.name = 'TransientProviderError';
  }
}

/** Why a provider refused a send, when it says so (Cloudflare `E_*` codes). */
export type ProviderRefusal = 'rate_limited' | 'daily_limit' | 'recipient_suppressed' | 'sender_not_allowed';

/**
 * The provider refused for a reason it named: a rate or daily quota, a
 * suppressed recipient, or a sender domain it doesn't send for. Extends
 * TransientProviderError so existing `instanceof` checks keep working.
 */
export class ProviderRefusedError extends TransientProviderError {
  constructor(
    public readonly refusal: ProviderRefusal,
    /** The recipient the refusal happened on. */
    public readonly recipient: string,
    message: string,
    provider: string,
    cause?: unknown,
    sentRecipients: string[] = [],
    messageId?: string,
  ) {
    super(message, provider, cause, sentRecipients, messageId);
    this.name = 'ProviderRefusedError';
  }
}

/** Provider rejected the request permanently — do not retry. */
export class PermanentProviderError extends EmailProviderError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause);
    this.name = 'PermanentProviderError';
  }
}
