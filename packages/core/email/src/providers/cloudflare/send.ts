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

import {
  PendingVerificationError,
  ProviderConfigError,
  TransientProviderError,
} from '../../core/errors';
import type {
  IEmailSendProvider,
  SendCapabilities,
  SendOptions,
  SendResult,
} from '../../core/types';
import type {
  EmailBindingAddress,
  EmailBindingAttachment,
  SendEmail,
} from './send-binding';
import type { EmailAddress, EmailAttachment } from '../../core/types';

const PROVIDER = 'cloudflare';

/** Cloudflare's cap on `to` + `cc` + `bcc` for a single send. */
const MAX_RECIPIENTS = 50;

export interface CloudflareSendProviderOptions {
  /** The Worker `[[send_email]]` binding. */
  sendEmail: SendEmail;
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
  }

  /**
   * One message to the whole recipient set, in a single binding call.
   *
   * The structured request hands Cloudflare the full to/cc/bcc lists and lets
   * it build the MIME: every recipient gets the same Message-ID and sees the
   * same To/Cc headers, so their client shows one message addressed to the
   * group and reply-all works. (Bcc recipients are delivered but stay out of
   * the headers.) The alternative — building a raw message per recipient and
   * calling the binding once each — turns a three-recipient reply-all into
   * three separate one-to-one messages.
   *
   * `Message-ID` is platform-generated and returned, so `options.messageId` is
   * not honoured; callers should persist the returned id.
   */
  async send(options: SendOptions): Promise<SendResult> {
    const total =
      options.to.length + (options.cc?.length ?? 0) + (options.bcc?.length ?? 0);
    if (total === 0) {
      throw new ProviderConfigError(PROVIDER, 'send() called with no recipients');
    }
    if (total > MAX_RECIPIENTS) {
      throw new ProviderConfigError(
        PROVIDER,
        `send() called with ${total} recipients; the binding accepts at most ${MAX_RECIPIENTS} across to/cc/bcc`,
      );
    }

    // In-Reply-To / References are on Cloudflare's header allowlist, and are
    // the reason a reply lands inside the recipient's existing thread.
    const headers: Record<string, string> = { ...options.headers };
    if (options.inReplyTo) headers['In-Reply-To'] = options.inReplyTo;
    if (options.references?.length) headers['References'] = options.references.join(' ');

    try {
      const result = await this.opts.sendEmail.send({
        from: toBindingAddress(options.from),
        to: options.to.map(toBindingAddress),
        cc: options.cc?.length ? options.cc.map(toBindingAddress) : undefined,
        bcc: options.bcc?.length ? options.bcc.map(toBindingAddress) : undefined,
        subject: options.subject,
        text: options.text,
        html: options.html,
        replyTo: options.replyTo ? toBindingAddress(options.replyTo) : undefined,
        headers: Object.keys(headers).length ? headers : undefined,
        attachments: options.attachments?.length
          ? options.attachments.map(toBindingAttachment)
          : undefined,
      });
      return { messageId: result.messageId };
    } catch (err) {
      // A recipient outside the account's allowed destination list is a
      // "needs verifying" state the caller can surface to the user, not a
      // transport blip worth retrying — keep it distinguishable.
      if (bindingErrorCode(err) === 'E_RECIPIENT_NOT_ALLOWED') {
        // The binding rejects the whole send without naming which address was
        // the problem, so report the full set rather than guessing.
        const recipients = [...options.to, ...(options.cc ?? []), ...(options.bcc ?? [])]
          .map((a) => a.email)
          .join(', ');
        throw new PendingVerificationError(recipients, PROVIDER);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new TransientProviderError(`send_email failed: ${msg}`, PROVIDER, err);
    }
  }
}

/**
 * Cloudflare throws plain `Error`s carrying a `code` (`E_RECIPIENT_NOT_ALLOWED`,
 * `E_HEADER_NOT_ALLOWED`, `E_RATE_LIMIT_EXCEEDED`, ...).
 */
function bindingErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function toBindingAddress(addr: EmailAddress): EmailBindingAddress {
  return addr.name ? { email: addr.email, name: addr.name } : { email: addr.email };
}

function toBindingAttachment(att: EmailAttachment): EmailBindingAttachment {
  return {
    content: att.content,
    filename: att.filename,
    type: att.contentType ?? 'application/octet-stream',
    // A `cid` means the body references it with `cid:` — that's an inline part.
    disposition: att.cid ? 'inline' : 'attachment',
    contentId: att.cid,
  };
}
