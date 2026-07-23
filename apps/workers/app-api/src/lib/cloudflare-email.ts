/**
 * Cloudflare email wrapper for app-api.
 *
 * Outbound mail goes through the Cloudflare `send_email` worker binding;
 * inbound is wired at the zone level by Email Routing (the catch-all rule
 * points at the `mail-inbound-worker`). Domain provisioning calls Email
 * Routing's REST API directly so the same worker that owns mail accounts
 * can also flip a customer zone over.
 *
 * All three paths are implemented by `@weldsuite/email`'s Cloudflare
 * provider — this file just narrows the binding shape to the app-api `Env`
 * and centralises the secret checks so route handlers stay readable.
 */

import { EmailMessage } from 'cloudflare:email';
import {
  CloudflareDomainProvider,
  CloudflareSendProvider,
  type ForwardableEmailMessage,
} from '@weldsuite/email/providers/cloudflare';
import { PendingVerificationError } from '@weldsuite/email';
import type { EmailAttachment } from '@weldsuite/email/core/types';
import { findZoneIdByName } from './cloudflare-zones';
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
  attachments?: EmailAttachment[];
}

export interface SendEmailResponse {
  messageId: string;
  /** True when Cloudflare requires the recipient to verify before delivery. */
  pendingVerification?: boolean;
}

/**
 * Send an email via the Cloudflare `send_email` binding. Fans out to one
 * `EmailMessage.send()` per recipient (the binding takes a single envelope
 * recipient at a time).
 *
 * Throws `PendingVerificationError` when at least one recipient hasn't yet
 * verified through Cloudflare's destination-address flow. Callers that want
 * to surface a "pending verification" state on the sent message should catch
 * it and inspect `recipient`.
 */
export async function sendEmail(
  env: Env,
  params: SendEmailParams,
): Promise<SendEmailResponse> {
  const provider = makeSendProvider(env);
  const recipients = [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])];
  if (recipients.length === 0) {
    throw new Error('sendEmail: no recipients');
  }

  const fromMatch = params.from.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  const fromEmail = fromMatch ? fromMatch[2]!.trim() : params.from.trim();
  const fromName = fromMatch ? fromMatch[1]!.trim() || undefined : undefined;

  let firstMessageId: string | undefined;
  let pendingVerification = false;

  for (const rcpt of recipients) {
    try {
      const result = await provider.send({
        from: { email: fromEmail, name: fromName },
        to: [{ email: rcpt }],
        subject: params.subject,
        text: params.text,
        html: params.html,
        replyTo: params.replyTo ? { email: params.replyTo } : undefined,
        headers: params.headers,
        inReplyTo: params.inReplyTo,
        references: params.references,
        attachments: params.attachments,
      });
      firstMessageId ??= result.messageId;
    } catch (err: unknown) {
      if (err instanceof PendingVerificationError) {
        pendingVerification = true;
        firstMessageId ??= err.recipient;
        continue;
      }
      throw err;
    }
  }

  return { messageId: firstMessageId ?? '', pendingVerification };
}

/**
 * Provision a customer zone for both Email Routing (inbound) and Email
 * Sending (outbound). Enables routing on the zone (auto-locks MX + SPF),
 * points the catch-all rule at the mail-inbound worker, and registers the
 * zone apex with Email Sending so the `[[send_email]]` binding will accept
 * `MAIL FROM:<*@domain>`.
 */
export async function createDomain(env: Env, domain: string): Promise<void> {
  const provider = makeDomainProvider(env);
  const result = await provider.provisionDomain(domain);
  const sending = (result.metadata as { sending?: { tag?: string; name?: string } } | undefined)?.sending;
  console.log(
    `[CFEmail] Provisioned ${domain}, ruleId=${result.externalRuleId}` +
      (sending ? `, sendingSubdomain=${sending.name} (tag=${sending.tag})` : ', sending=skipped'),
  );
}

export async function deleteDomain(env: Env, domain: string): Promise<void> {
  const provider = makeDomainProvider(env);
  await provider.deprovisionDomain(domain);
  console.log(`[CFEmail] Deprovisioned ${domain}`);
}

export async function getDomain(
  env: Env,
  domain: string,
): Promise<Record<string, unknown>> {
  const provider = makeDomainProvider(env);
  const verify = await provider.verifyDomain?.(domain);
  return {
    domain,
    verified: verify?.verified ?? false,
    records: verify?.records ?? [],
  };
}

function makeSendProvider(env: Env): CloudflareSendProvider {
  if (!env.SEND_EMAIL) {
    throw new Error('SEND_EMAIL binding missing — wrangler [[send_email]] not configured');
  }
  return new CloudflareSendProvider({
    sendEmail: env.SEND_EMAIL,
    EmailMessage,
  });
}

function makeDomainProvider(env: Env): CloudflareDomainProvider {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN missing — required for Cloudflare Email Routing API');
  }
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  return new CloudflareDomainProvider({
    apiToken,
    resolveZoneId: async (domain: string) => {
      const zoneId = await findZoneIdByName(apiToken, domain);
      if (!zoneId) throw new Error(`No Cloudflare zone found for domain ${domain}`);
      return zoneId;
    },
    defaultReceiveWorker: env.MAIL_INBOUND_WORKER_NAME ?? 'weldsuite-mail-inbound',
  });
}

export type { ForwardableEmailMessage };
