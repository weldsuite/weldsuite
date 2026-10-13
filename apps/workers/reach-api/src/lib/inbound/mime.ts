/**
 * Raw RFC 822 bytes to a `ParsedInbound`, with postal-mime doing the MIME work.
 *
 * Delivery reports arrive as `multipart/report`; postal-mime hands the
 * `message/delivery-status` part, the attached original (`message/rfc822`) and
 * a headers-only copy (`text/rfc822-headers`) back as attachments, which are
 * decoded into `reportParts` for the bounce parser.
 */

import PostalMime, { type Address, type Email } from 'postal-mime';
import { normalizeMessageId, parseMessageIdList } from './message-id';
import { htmlToText } from './text';
import type { ParsedAddress, ParsedInbound, ReportPart } from './types';

const REPORT_MIME_TYPES = new Set([
  'message/delivery-status',
  'message/rfc822',
  'text/rfc822-headers',
  'message/disposition-notification',
  'message/feedback-report',
]);

/** Cap for one decoded report part: a bounce quoting a 20 MB attachment must not be copied around. */
const MAX_REPORT_PART_CHARS = 200_000;

function toParsedAddress(address: Address | undefined): ParsedAddress | null {
  if (!address) return null;
  const mailbox = address.address !== undefined ? address : address.group?.[0];
  if (!mailbox?.address) return null;
  return { email: mailbox.address.trim().toLowerCase(), name: mailbox.name?.trim() || null };
}

function flattenAddresses(addresses: Address[] | undefined): string[] {
  const out: string[] = [];
  for (const address of addresses ?? []) {
    if (address.address) out.push(address.address.trim().toLowerCase());
    else for (const member of address.group ?? []) if (member.address) out.push(member.address.trim().toLowerCase());
  }
  return out;
}

function decodePart(content: ArrayBuffer | string): string {
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  return text.length > MAX_REPORT_PART_CHARS ? text.slice(0, MAX_REPORT_PART_CHARS) : text;
}

function collectReportParts(email: Email): ReportPart[] {
  const parts: ReportPart[] = [];
  for (const attachment of email.attachments) {
    const mimeType = attachment.mimeType.toLowerCase();
    if (REPORT_MIME_TYPES.has(mimeType)) parts.push({ mimeType, text: decodePart(attachment.content) });
  }
  return parts;
}

function collectHeaders(email: Email): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of email.headers) {
    if (!(header.key in headers)) headers[header.key] = header.value;
  }
  return headers;
}

/** The message's text: its text part, or the HTML part converted to text. */
function bodyText(email: Email): string {
  if (email.text && email.text.trim() !== '') return email.text;
  if (email.html && email.html.trim() !== '') return htmlToText(email.html);
  return '';
}

export async function parseInbound(raw: Uint8Array): Promise<ParsedInbound> {
  const email = await PostalMime.parse(raw);
  const headers = collectHeaders(email);
  return {
    messageId: normalizeMessageId(email.messageId),
    inReplyTo: normalizeMessageId(email.inReplyTo),
    references: parseMessageIdList(email.references),
    from: toParsedAddress(email.from),
    to: flattenAddresses(email.to),
    subject: (email.subject ?? '').trim(),
    text: bodyText(email),
    headers,
    contentType: headers['content-type'] ?? '',
    reportParts: collectReportParts(email),
  };
}

/** The text of one stored message (used when the inbox shows a thread): its text part or converted HTML. */
export async function extractMessageText(raw: Uint8Array): Promise<string> {
  const email = await PostalMime.parse(raw);
  return bodyText(email);
}
