/**
 * Cloudflare Email Sending for personal-api.
 * Same pattern as app-api/src/lib/cloudflare-email.ts — Workers [[send_email]] binding.
 */

import { EmailMessage } from 'cloudflare:email';
import { CloudflareSendProvider } from '@weldsuite/email/providers/cloudflare';
import { PendingVerificationError } from '@weldsuite/email';
import type { Env } from '../types';

export interface SendEmailParams {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  headers?: Record<string, string>;
  inReplyTo?: string;
  references?: string[];
}

export interface SendEmailResponse {
  messageId: string;
  pendingVerification?: boolean;
}

export async function sendEmail(
  env: Env,
  params: SendEmailParams,
): Promise<SendEmailResponse> {
  if (!env.SEND_EMAIL) {
    throw new Error('SEND_EMAIL binding missing — wrangler [[send_email]] not configured');
  }

  const provider = new CloudflareSendProvider({
    // Runtime binding matches CloudflareSendProvider's SendEmail interface.
    sendEmail: env.SEND_EMAIL as never,
    EmailMessage,
  });

  if (params.to.length + (params.cc?.length ?? 0) + (params.bcc?.length ?? 0) === 0) {
    throw new Error('sendEmail: no recipients');
  }

  const fromMatch = params.from.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  const fromEmail = fromMatch ? fromMatch[2]!.trim() : params.from.trim();
  const fromName = fromMatch ? fromMatch[1]!.trim() || undefined : undefined;

  try {
    const result = await provider.send({
      from: { email: fromEmail, name: fromName },
      to: params.to.map((email) => ({ email })),
      cc: params.cc?.map((email) => ({ email })),
      bcc: params.bcc?.map((email) => ({ email })),
      subject: params.subject,
      text: params.text,
      html: params.html,
      replyTo: params.replyTo ? { email: params.replyTo } : undefined,
      headers: params.headers,
      inReplyTo: params.inReplyTo,
      references: params.references,
    });
    const pending = (result.metadata as { pendingRecipients?: string[] } | undefined)
      ?.pendingRecipients;
    return { messageId: result.messageId, pendingVerification: !!pending?.length };
  } catch (err: unknown) {
    if (err instanceof PendingVerificationError) {
      return { messageId: err.recipient, pendingVerification: true };
    }
    throw err;
  }
}
