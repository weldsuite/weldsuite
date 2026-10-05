/**
 * Cloudflare Email Service REST transport (`POST /accounts/{id}/email/sending/send`),
 * for code that has no Workers binding: the Next.js apps (booking portal,
 * admin) and scripts. Goes through the official SDK, tree-shaken to the one
 * resource it needs.
 */

import { createClient } from 'cloudflare/tree-shakable';
import { BaseEmailSending } from 'cloudflare/resources/email-sending/email-sending';
import {
  attachmentBytes,
  baseContentType,
  toBase64,
  type EmailTransport,
  type Mailbox,
  type OutgoingEmail,
  type SendResult,
} from '../transport';

export interface RestTransportOptions {
  accountId: string;
  /** API token with only the "Email Sending: Send" permission. */
  apiToken: string;
  /** Test hook. */
  fetch?: typeof fetch;
}

function address({ email, name }: Mailbox) {
  return name?.trim() ? { address: email, name: name.replace(/[\r\n]/g, ' ').trim() } : email;
}

export function restTransport(options: RestTransportOptions): EmailTransport {
  if (!options.accountId || !options.apiToken) {
    throw new Error('restTransport: accountId and apiToken are required');
  }
  const client = createClient({
    apiToken: options.apiToken,
    maxRetries: 2,
    timeout: 15_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    resources: [BaseEmailSending],
  });

  return {
    name: 'cloudflare-rest',
    async send(email: OutgoingEmail): Promise<SendResult> {
      const result = await client.emailSending.send({
        account_id: options.accountId,
        from: address(email.from),
        to: email.to.map((m) => m.email),
        ...(email.cc?.length ? { cc: email.cc.map((m) => m.email) } : {}),
        ...(email.bcc?.length ? { bcc: email.bcc.map((m) => m.email) } : {}),
        ...(email.replyTo ? { reply_to: address(email.replyTo) } : {}),
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.headers ? { headers: email.headers } : {}),
        ...(email.attachments?.length
          ? {
              attachments: email.attachments.map((a) => ({
                filename: a.filename,
                content: toBase64(attachmentBytes(a.content)),
                type: baseContentType(a.contentType),
                disposition: 'attachment' as const,
              })),
            }
          : {}),
      });
      return {
        messageId: result.message_id,
        transport: 'cloudflare-rest',
        ...(result.permanent_bounces?.length ? { rejected: result.permanent_bounces } : {}),
      };
    },
  };
}
