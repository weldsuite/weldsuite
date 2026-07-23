/**
 * RFC 5322 builder for outbound email. Wraps the `mimetext` library so send
 * providers (Cloudflare's send_email binding, anything SMTP-shaped) get a
 * single canonical builder.
 */

import { createMimeMessage } from 'mimetext';
import type { EmailAddress, EmailAttachment, SendOptions } from './types';
import { formatEmailAddress } from './types';

export interface BuiltEmail {
  raw: string;
  messageId: string;
}

/**
 * Build an RFC 5322 message string from SendOptions. The returned `raw` is
 * suitable for `EmailMessage(from, to, raw)` (Cloudflare send_email binding)
 * or any SMTP transport. Returns the resolved Message-ID so the caller can
 * persist it on the sent-message row.
 */
export function buildRfc5322(options: SendOptions): BuiltEmail {
  const msg = createMimeMessage();

  msg.setSender({
    addr: options.from.email,
    name: options.from.name,
  });

  msg.setRecipients(options.to.map(addrToMimetext), { type: 'To' });
  if (options.cc?.length) msg.setRecipients(options.cc.map(addrToMimetext), { type: 'Cc' });
  if (options.bcc?.length) msg.setRecipients(options.bcc.map(addrToMimetext), { type: 'Bcc' });
  if (options.replyTo) {
    msg.setHeader('Reply-To', formatEmailAddress(options.replyTo));
  }

  msg.setSubject(options.subject);

  const messageId = options.messageId ?? generateMessageId(options.from.email);
  msg.setHeader('Message-ID', messageId);

  if (options.inReplyTo) msg.setHeader('In-Reply-To', options.inReplyTo);
  if (options.references?.length) msg.setHeader('References', options.references.join(' '));
  if (options.priority) {
    const map: Record<NonNullable<SendOptions['priority']>, string> = {
      high: '1 (Highest)',
      normal: '3 (Normal)',
      low: '5 (Lowest)',
    };
    msg.setHeader('X-Priority', map[options.priority]);
  }

  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      msg.setHeader(k, v);
    }
  }

  if (options.text) msg.addMessage({ contentType: 'text/plain', data: options.text });
  if (options.html) msg.addMessage({ contentType: 'text/html', data: options.html });

  for (const att of options.attachments ?? []) {
    addAttachment(msg, att);
  }

  return { raw: msg.asRaw(), messageId };
}

function addrToMimetext(addr: EmailAddress): { addr: string; name?: string } {
  return { addr: addr.email, name: addr.name };
}

function addAttachment(
  msg: ReturnType<typeof createMimeMessage>,
  att: EmailAttachment,
): void {
  const data =
    typeof att.content === 'string'
      ? att.content
      : att.content instanceof Uint8Array
      ? bytesToBase64(att.content)
      : bytesToBase64(new Uint8Array(att.content));
  const encoding = typeof att.content === 'string' ? undefined : 'base64';
  msg.addAttachment({
    filename: att.filename,
    contentType: att.contentType ?? 'application/octet-stream',
    data,
    encoding,
    inline: !!att.cid,
    headers: att.cid ? { 'Content-ID': `<${att.cid}>` } : undefined,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.includes('@') ? fromEmail.split('@')[1] : 'weldmail.local';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `<${hex}@${domain}>`;
}
