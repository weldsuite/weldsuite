/**
 * Quoting the original message under a reply, for both parts of the mail:
 * `> `-prefixed lines in the text/plain part and a Gmail-style
 * `<div class="gmail_quote">` block in the HTML part. The thread view collapses
 * that block (and every other mail client does too), so the quote does not
 * crowd the reply.
 */
import { htmlToPlainText, plainTextToHtml, type ComposeBodies } from '@/app/weldmail/lib/compose-body';
import { escapeHtml } from '@/app/weldmail/lib/link-url';

/** The message a reply answers. */
export interface ReplyQuoteSource {
  /** Who wrote it: a name, an address, or "Name <address>". */
  sender: string;
  sentAt?: Date | string | null;
  /** The original's HTML part; the server sanitizes the mail it goes into. */
  html?: string | null;
  /** The original's text part, used when it has no HTML. */
  text?: string | null;
}

/** "Name <address>" for the attribution line, from whichever of the two a message has. */
export function quoteSender(
  from: string | { name?: string; email?: string } | undefined,
  fromEmail?: string,
): string {
  const name = typeof from === 'string' ? from : from?.name;
  const email = fromEmail || (typeof from === 'string' ? undefined : from?.email);
  if (name && email && name !== email && !name.includes(email)) return `${name} <${email}>`;
  return name || email || '';
}

/** Written the way the sender's own mail client would show it ("Oct 20, 2026, 9:00 AM"). */
function formatQuoteDate(value: Date | string | null | undefined, locale?: string): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function quoteText(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * Appends the quoted original to a reply's bodies. `header` is the localized
 * "On {date}, {sender} wrote:" line. An original with no content leaves the
 * reply as it was.
 */
export function appendQuotedOriginal(
  bodies: ComposeBodies,
  original: ReplyQuoteSource,
  header: string,
  locale?: string,
): ComposeBodies {
  const originalText = original.html ? htmlToPlainText(original.html) : (original.text ?? '').trim();
  const originalHtml = original.html?.trim() || (originalText ? plainTextToHtml(originalText) : '');
  if (!originalText && !originalHtml) return bodies;

  const attribution = header
    .replace('{date}', formatQuoteDate(original.sentAt, locale))
    .replace('{sender}', original.sender);

  return {
    body: `${bodies.body}\n\n${attribution}\n${quoteText(originalText)}`,
    htmlBody:
      `${bodies.htmlBody}<br><div class="gmail_quote">` +
      `<div dir="ltr" class="gmail_attr">${escapeHtml(attribution)}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
      `${originalHtml}</blockquote></div>`,
  };
}
