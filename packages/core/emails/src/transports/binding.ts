/**
 * Cloudflare Workers `[[send_email]]` binding transport. Workers only: it
 * imports the runtime module `cloudflare:email` (tests alias it to a stub).
 *
 * Sends the raw-MIME `EmailMessage` form through `@weldsuite/email`'s provider,
 * the path already proven in production by the HR and commerce portal mails.
 */

import { EmailMessage } from 'cloudflare:email';
import { CloudflareSendProvider } from '@weldsuite/email/providers/cloudflare/send';
import type { SendEmail } from '@weldsuite/email/providers/cloudflare';
import { attachmentBytes, withFromAddress, type EmailTransport, type OutgoingEmail, type SendResult } from '../transport';
import { resendTransport } from './resend';

export function bindingTransport(binding: SendEmail): EmailTransport {
  const provider = new CloudflareSendProvider({ sendEmail: binding, EmailMessage });
  return {
    name: 'cloudflare-binding',
    async send(email: OutgoingEmail): Promise<SendResult> {
      const result = await provider.send({
        from: email.from,
        to: email.to,
        cc: email.cc,
        bcc: email.bcc,
        replyTo: email.replyTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: email.headers,
        attachments: email.attachments?.map((a) => ({
          filename: a.filename,
          content: attachmentBytes(a.content),
          contentType: a.contentType,
        })),
      });
      const pending = (result.metadata as { pendingRecipients?: string[] } | undefined)?.pendingRecipients;
      return {
        messageId: result.messageId,
        transport: 'cloudflare-binding',
        ...(pending?.length ? { rejected: pending } : {}),
      };
    },
  };
}

/** The env keys `workerTransport` reads. Any worker Env with them fits. */
export interface SystemEmailEnv {
  SEND_EMAIL?: SendEmail;
  /**
   * Migration switch: `resend` sends through Resend instead of Cloudflare
   * (needs RESEND_API_KEY). Anything else, or unset, means Cloudflare when the
   * worker has a SEND_EMAIL binding. Removed together with Resend at the end
   * of the migration.
   */
  EMAIL_TRANSPORT?: string;
  RESEND_API_KEY?: string;
  /** Migration only: send from this address instead of the system one. See `withFromAddress`. */
  SYSTEM_EMAIL_FROM?: string;
}

/**
 * The transport a worker should send system email with, or undefined when the
 * worker has none configured (local dev without bindings). Callers treat
 * undefined as "skip sending", like the old `if (!RESEND_API_KEY) return`.
 */
export function workerTransport(env: SystemEmailEnv): EmailTransport | undefined {
  const forceResend = env.EMAIL_TRANSPORT?.trim().toLowerCase() === 'resend';
  // Resend when switched to it, or as the fallback for a worker that has no
  // SEND_EMAIL binding yet; the binding otherwise.
  const transport =
    (forceResend || !env.SEND_EMAIL) && env.RESEND_API_KEY
      ? resendTransport({ apiKey: env.RESEND_API_KEY })
      : env.SEND_EMAIL
        ? bindingTransport(env.SEND_EMAIL)
        : undefined;
  return transport ? withFromAddress(transport, env.SYSTEM_EMAIL_FROM) : undefined;
}
