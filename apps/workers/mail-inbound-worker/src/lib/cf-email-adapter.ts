/**
 * Cloudflare Email Worker → worker-local ParsedEmail adapter.
 *
 * The receive pipeline in `email-storage.ts` predates `@weldsuite/email` and
 * has its own `ParsedEmail` / `ParsedAttachment` shapes. Rather than churn
 * 1500 lines of storage code, we translate at the boundary.
 */

import {
  CloudflareReceiveProvider,
  type ForwardableEmailMessage,
} from '@weldsuite/email/providers/cloudflare';
import type { ParsedInboundEmail } from '@weldsuite/email';
import { sanitizeEmailHtml } from '@weldsuite/email/sanitize';
import { nanoid } from 'nanoid';
import type { ParsedEmail, SecurityStatus } from './email-storage';
import type { ParsedAttachment } from './email-storage';

const provider = new CloudflareReceiveProvider();

/** Map a generic SPF/DKIM/DMARC string to the worker's narrower enum. */
function toSecurityStatus(s: string | undefined): SecurityStatus | undefined {
  if (!s) return undefined;
  const allowed: SecurityStatus[] = ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror'];
  return allowed.includes(s as SecurityStatus) ? (s as SecurityStatus) : undefined;
}

export interface AdaptedInbound {
  email: ParsedEmail;
  attachments: ParsedAttachment[];
}

export async function adaptCloudflareEmail(
  message: ForwardableEmailMessage,
): Promise<AdaptedInbound> {
  const parsed: ParsedInboundEmail = await provider.parse(message);
  return {
    // `message.to` is the SMTP envelope recipient for this delivery. Cloudflare
    // invokes the worker once per recipient, so this single address is the
    // authoritative target — and the only signal for a CC/BCC-only recipient
    // whose address isn't in the visible To header.
    email: toParsedEmail(parsed, message.to),
    attachments: parsed.attachments.map(toParsedAttachment),
  };
}

function toParsedEmail(p: ParsedInboundEmail, envelopeTo?: string): ParsedEmail {
  return {
    emailId: nanoid(),
    messageId: p.messageId,
    from: p.from,
    to: p.to,
    cc: p.cc ?? [],
    envelopeTo: envelopeTo ? [envelopeTo] : [],
    subject: p.subject,
    textBody: p.textBody ?? null,
    // Sanitize at the ingest boundary so every downstream write (mailbox,
    // helpdesk thread, accounting doc) stores script-free HTML.
    htmlBody: sanitizeEmailHtml(p.htmlBody) || null,
    headers: p.headers,
    receivedAt: p.receivedAt,
    hasAttachments: p.attachments.length > 0,
    attachmentCount: p.attachments.length,
    inReplyTo: p.inReplyTo,
    references: p.references,
    spfStatus: toSecurityStatus(p.spfStatus),
    dkimStatus: toSecurityStatus(p.dkimStatus),
    dmarcStatus: toSecurityStatus(p.dmarcStatus),
    rawMessage: typeof p.rawEmail === 'string' ? p.rawEmail : undefined,
  };
}

function toParsedAttachment(att: ParsedInboundEmail['attachments'][number]): ParsedAttachment {
  return {
    fileName: att.filename,
    contentType: att.contentType,
    content: new Uint8Array(att.content),
    contentId: att.cid,
  };
}
