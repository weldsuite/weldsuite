/**
 * Resend transport, kept only as the `EMAIL_TRANSPORT=resend` fallback while
 * the senders move to Cloudflare. Delete with the rest of Resend in the last
 * migration phase (docs/plans/system-email-cloudflare.md).
 */

import {
  attachmentBytes,
  formatMailbox,
  toBase64,
  type EmailTransport,
  type OutgoingEmail,
  type SendResult,
} from '../transport';

export interface ResendTransportOptions {
  apiKey: string;
  /** Test hook. */
  fetch?: typeof fetch;
}

export function resendTransport(options: ResendTransportOptions): EmailTransport {
  const doFetch = options.fetch ?? fetch;
  return {
    name: 'resend',
    async send(email: OutgoingEmail): Promise<SendResult> {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: formatMailbox(email.from),
          to: email.to.map(formatMailbox),
          ...(email.cc?.length ? { cc: email.cc.map(formatMailbox) } : {}),
          ...(email.bcc?.length ? { bcc: email.bcc.map(formatMailbox) } : {}),
          ...(email.replyTo ? { reply_to: formatMailbox(email.replyTo) } : {}),
          subject: email.subject,
          html: email.html,
          text: email.text,
          ...(email.headers ? { headers: email.headers } : {}),
          ...(email.attachments?.length
            ? {
                attachments: email.attachments.map((a) => ({
                  filename: a.filename,
                  content: toBase64(attachmentBytes(a.content)),
                  content_type: a.contentType,
                })),
              }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`Resend API error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { id?: string };
      return { messageId: data.id ?? '', transport: 'resend' };
    },
  };
}
