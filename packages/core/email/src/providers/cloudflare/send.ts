/**
 * Cloudflare `send_email` binding → IEmailSendProvider.
 *
 * Sends straight through Cloudflare's Email Service binding. Recipients are
 * not auto-registered as Email Routing destination addresses — that pattern
 * polluted the account's destination list and emailed customers a confusing
 * "Verify this Email Routing address" notice instead of the actual message.
 * Sending to arbitrary recipients requires the Cloudflare account to be on
 * Workers Paid (Email Service) — without it the binding rejects unverified
 * recipients and that error surfaces as a TransientProviderError.
 */

import { ProviderConfigError, TransientProviderError } from '../../core/errors';
import { buildRfc5322 } from '../../core/mime';
import type {
  IEmailSendProvider,
  SendCapabilities,
  SendOptions,
  SendResult,
} from '../../core/types';
import { formatEmailAddress } from '../../core/types';
import type { EmailMessageCtor, SendEmail } from './send-binding';

const PROVIDER = 'cloudflare';

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

  async send(options: SendOptions): Promise<SendResult> {
    if (options.to.length !== 1 || options.cc?.length || options.bcc?.length) {
      throw new ProviderConfigError(
        PROVIDER,
        'send_email binding takes one recipient; fan out before calling send()',
      );
    }
    const recipient = options.to[0]!;

    const { raw, messageId } = buildRfc5322(options);
    const message = new this.opts.EmailMessage(
      formatEmailAddress(options.from),
      recipient.email,
      raw,
    );

    try {
      await this.opts.sendEmail.send(message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TransientProviderError(`send_email failed: ${msg}`, PROVIDER, err);
    }

    return { messageId };
  }
}
