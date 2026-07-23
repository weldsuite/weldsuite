/**
 * Provider-agnostic RFC 5322 → ParsedInboundEmail conversion via postal-mime.
 *
 * Receive providers call this on the raw bytes they get from the underlying
 * transport (Cloudflare ForwardableEmailMessage.raw, HTTP body, IMAP fetch,
 * ...). The output is the same regardless of where the bytes came from,
 * so downstream storage code stays provider-agnostic.
 */

import PostalMime, { type Email as PostalEmail, type Address } from 'postal-mime';
import type { EmailAddress, ParsedAttachment, ParsedInboundEmail } from './types';
import { parseEmailAddress } from './types';

export interface ParseRawOptions {
  /** Provider-specific extras to merge into the result's metadata field. */
  metadata?: Record<string, unknown>;
}

export async function parseRawEmail(
  raw: ArrayBuffer | Uint8Array | string,
  options: ParseRawOptions = {},
): Promise<ParsedInboundEmail> {
  const parser = new PostalMime();
  // postal-mime accepts ArrayBuffer/Uint8Array/string directly.
  const input: ArrayBuffer | string =
    typeof raw === 'string'
      ? raw
      : raw instanceof Uint8Array
      ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
      : raw;
  const parsed = (await parser.parse(input)) as PostalEmail;

  const headers: Record<string, string> = {};
  for (const h of parsed.headers ?? []) {
    headers[h.key.toLowerCase()] = h.value;
  }

  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map((att) => {
    const content =
      att.content instanceof ArrayBuffer
        ? att.content
        : typeof att.content === 'string'
        ? new TextEncoder().encode(att.content).buffer
        : (att.content as Uint8Array).buffer.slice(
            (att.content as Uint8Array).byteOffset,
            (att.content as Uint8Array).byteOffset + (att.content as Uint8Array).byteLength,
          );
    return {
      filename: att.filename ?? 'attachment',
      contentType: att.mimeType ?? 'application/octet-stream',
      size: (content as ArrayBuffer).byteLength,
      content: content as ArrayBuffer,
      cid: att.contentId ?? undefined,
    };
  });

  const size =
    typeof raw === 'string'
      ? new TextEncoder().encode(raw).byteLength
      : raw instanceof Uint8Array
      ? raw.byteLength
      : (raw as ArrayBuffer).byteLength;

  // ParsedInboundEmail.rawEmail is `ArrayBuffer | string | undefined` —
  // narrow Uint8Array inputs by extracting their backing buffer.
  const rawEmail: ArrayBuffer | string =
    typeof raw === 'string'
      ? raw
      : raw instanceof Uint8Array
      ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
      : raw;

  return {
    messageId: parsed.messageId ?? cryptoRandomMessageId(),
    from: addressToEmailAddress(parsed.from),
    to: addressesToEmailAddresses(parsed.to),
    cc: addressesToEmailAddresses(parsed.cc),
    bcc: addressesToEmailAddresses(parsed.bcc),
    subject: parsed.subject ?? '',
    textBody: parsed.text,
    htmlBody: parsed.html,
    attachments,
    headers,
    receivedAt: parsed.date ? new Date(parsed.date) : new Date(),
    rawEmail,
    size,
    inReplyTo: parsed.inReplyTo ?? undefined,
    references: parsed.references
      ? parsed.references.split(/\s+/).filter(Boolean)
      : undefined,
    metadata: options.metadata,
  };
}

function addressToEmailAddress(addr: Address | Address[] | undefined): EmailAddress {
  if (!addr) return { email: 'unknown@unknown.com' };
  const single = Array.isArray(addr) ? addr[0] : addr;
  if (!single) return { email: 'unknown@unknown.com' };
  return parseEmailAddress({ email: single.address, name: single.name });
}

function addressesToEmailAddresses(addr: Address[] | undefined): EmailAddress[] {
  if (!addr) return [];
  return addr.map((a) => parseEmailAddress({ email: a.address, name: a.name }));
}

function cryptoRandomMessageId(): string {
  // 32 hex chars + an @ host suffix — only used as a fallback when an inbound
  // email is missing a Message-ID header.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `<${hex}@weldmail.local>`;
}
