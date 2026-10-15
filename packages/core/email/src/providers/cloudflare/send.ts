/**
 * Cloudflare `send_email` binding → IEmailSendProvider.
 *
 * Sends straight through Cloudflare's Email Routing send binding. Recipients
 * are not auto-registered as Email Routing destination addresses — that pattern
 * polluted the account's destination list and emailed customers a confusing
 * "Verify this Email Routing address" notice instead of the actual message.
 * Sending to arbitrary recipients requires the Cloudflare account to be on
 * Workers Paid (Email Service) — without it the binding rejects unverified
 * recipients and that error surfaces as a PendingVerificationError.
 *
 * Cloudflare's newer Email Service exposes a structured
 * `send({to, cc, bcc, ...})` on the same binding name, which would replace the
 * envelope fan-out below with one call. It is NOT available to this account's
 * binding — calling it throws inside the binding and every send 500s — so we
 * stay on the `EmailMessage` form. Revisit only with a live send to prove it.
 */

import {
  PendingVerificationError,
  ProviderConfigError,
  ProviderRefusedError,
  TransientProviderError,
  type ProviderRefusal,
} from '../../core/errors';
import { buildRfc5322 } from '../../core/mime';
import type {
  IEmailSendProvider,
  SendCapabilities,
  SendOptions,
  SendResult,
} from '../../core/types';
import { formatEmailAddress } from '../../core/types';
import type { EmailMessage, EmailMessageCtor, SendEmail } from './send-binding';
import { asText } from '@weldsuite/text';

const PROVIDER = 'cloudflare';

/** Cloudflare's cap on `to` + `cc` + `bcc` for a single message. */
const MAX_RECIPIENTS = 50;

export interface CloudflareSendProviderOptions {
  /** The Worker `[[send_email]]` binding. */
  sendEmail: SendEmail;
  /** The `EmailMessage` class from `cloudflare:email`. Workers must pass it
   *  in (we can't import the runtime module from a generic shared package). */
  EmailMessage: EmailMessageCtor;
}

export class CloudflareSendProvider implements IEmailSendProvider {
  readonly name = PROVIDER;
  readonly capabilities: SendCapabilities = {
    firstTouchToUnverified: true,
    bulk: false,
    tracking: false,
    attachments: true,
  };

  constructor(private readonly opts: CloudflareSendProviderOptions) {
    if (!opts.sendEmail) throw new ProviderConfigError(PROVIDER, 'sendEmail');
    if (!opts.EmailMessage) throw new ProviderConfigError(PROVIDER, 'EmailMessage');
  }

  /**
   * One message, N envelope recipients.
   *
   * The binding takes a single envelope recipient per `EmailMessage`, so the
   * send is fanned out — but the RFC-5322 payload is built ONCE and reused for
   * every envelope. That distinction is the whole point: all copies share one
   * Message-ID and carry the same To/Cc headers, so recipients see a single
   * message addressed to the group and their clients thread it as one. Build
   * per recipient instead and a reply-all lands as N separate messages, each
   * appearing to be addressed to one person.
   *
   * Bcc recipients get an envelope but are absent from the headers (see
   * `buildRfc5322`), so the blind list stays blind.
   */
  async send(options: SendOptions): Promise<SendResult> {
    const envelopeRecipients = [...options.to, ...(options.cc ?? []), ...(options.bcc ?? [])];
    if (envelopeRecipients.length === 0) {
      throw new ProviderConfigError(PROVIDER, 'send() called with no recipients');
    }
    if (envelopeRecipients.length > MAX_RECIPIENTS) {
      throw new ProviderConfigError(
        PROVIDER,
        `send() called with ${envelopeRecipients.length} recipients; at most ${MAX_RECIPIENTS} across to/cc/bcc`,
      );
    }

    const { raw, messageId } = buildRfc5322(options);
    const from = formatEmailAddress(options.from);

    const outcome: EnvelopeOutcome = { sent: [], pending: [], suppressed: [] };
    for (const rcpt of envelopeRecipients) {
      await this.sendEnvelope(new this.opts.EmailMessage(from, rcpt.email, raw), rcpt.email, outcome, messageId);
    }
    const { sent: sentRecipients, pending: pendingRecipients, suppressed: suppressedRecipients } = outcome;

    if (sentRecipients.length === 0 && pendingRecipients.length === 0 && suppressedRecipients.length > 0) {
      throw new ProviderRefusedError(
        'recipient_suppressed',
        suppressedRecipients[0]!,
        `send_email refused: every recipient is suppressed (${suppressedRecipients.join(', ')})`,
        PROVIDER,
        undefined,
        [],
        messageId,
      );
    }

    const metadata = {
      ...(pendingRecipients.length ? { pendingRecipients } : {}),
      ...(suppressedRecipients.length ? { suppressedRecipients } : {}),
    };
    return {
      messageId,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    };
  }

  /**
   * One envelope. A recipient that needs verifying or that Cloudflare
   * suppressed is noted and skipped; any other failure ends the send, carrying
   * the recipients that already got it.
   */
  private async sendEnvelope(
    message: EmailMessage,
    recipient: string,
    outcome: EnvelopeOutcome,
    messageId: string,
  ): Promise<void> {
    try {
      await this.opts.sendEmail.send(message);
      outcome.sent.push(recipient);
    } catch (err) {
      // A recipient outside the account's allowed destination list is a
      // "needs verifying" state the caller can surface to the user, not a
      // transport blip — and it shouldn't sink delivery to everybody else.
      if (isRecipientNotAllowed(err)) {
        outcome.pending.push(recipient);
        return;
      }
      const refusal = refusalOf(err);
      // Cloudflare suppressed this address (an earlier hard bounce or spam
      // complaint): skip it, the others still get the message.
      if (refusal === 'recipient_suppressed') {
        outcome.suppressed.push(recipient);
        return;
      }
      const text = `send_email failed for ${recipient}: ${describeError(err)}`;
      if (refusal) {
        throw new ProviderRefusedError(refusal, recipient, text, PROVIDER, err, outcome.sent, messageId);
      }
      throw new TransientProviderError(text, PROVIDER, err, outcome.sent, messageId);
    }
  }
}

interface EnvelopeOutcome {
  sent: string[];
  pending: string[];
  suppressed: string[];
}

/** Cloudflare's Email Service error codes we act on (others stay a plain transient error). */
function refusalOf(err: unknown): ProviderRefusal | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  switch (code) {
    case 'E_RATE_LIMIT_EXCEEDED':
      return 'rate_limited';
    case 'E_DAILY_LIMIT_EXCEEDED':
      return 'daily_limit';
    case 'E_RECIPIENT_SUPPRESSED':
      return 'recipient_suppressed';
    case 'E_SENDER_NOT_VERIFIED':
    case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
      return 'sender_not_allowed';
    default:
      return null;
  }
}

/**
 * Cloudflare signals an unallowed destination either as a coded Error
 * (`E_RECIPIENT_NOT_ALLOWED`, Email Service) or as our own
 * `PendingVerificationError` if a future binding throws one directly.
 */
function isRecipientNotAllowed(err: unknown): boolean {
  if (err instanceof PendingVerificationError) return true;
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === 'E_RECIPIENT_NOT_ALLOWED';
}

/**
 * Binding failures have reached us with an empty `message`, which produced a
 * bare "send_email failed:" in the logs and told us nothing. Fall back through
 * whatever identifying fields the thrown value actually carries.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const parts = [err.name, typeof code === 'string' ? `(${code})` : '', err.message]
      .filter(Boolean)
      .join(' ');
    return parts.trim() || 'unknown error';
  }
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return asText(err);
    }
  }
  return asText(err) || 'unknown error';
}
