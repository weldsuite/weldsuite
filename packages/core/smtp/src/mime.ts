/**
 * RFC 5322 / MIME message building for outreach email.
 *
 * Hand-rolled so it runs on Workers (TextEncoder + btoa, no Buffer) and so the
 * output is exactly what we expect: CRLF line endings only, quoted-printable
 * bodies (7-bit clean, so no 8BITMIME negotiation is needed), RFC 2047 encoded
 * words for non-ASCII header text, and header folding at 78 characters.
 *
 * Header values never contain a raw CR or LF, whatever the caller passes in, so
 * a subject or display name cannot inject headers.
 */
import type { MailAddress, OutgoingMessage } from './types';
import { randomHex, toBase64, utf8 } from './util';

const CRLF = '\r\n';
const MAX_LINE_LENGTH = 78;

/**
 * Max UTF-8 bytes per encoded word. 42 bytes become 56 base64 characters, so a
 * word is `=?UTF-8?B?` + 56 + `?=` = 68 characters. With the longest header
 * prefix we ever encode after ("Reply-To: ", 10 characters) the first line is
 * still exactly 78, and the RFC 2047 limit of 75 per word is respected.
 */
const MAX_ENCODED_WORD_BYTES = 42;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Headers this builder owns; a caller-supplied header with one of these names is ignored. */
const RESERVED_HEADERS = new Set([
  'message-id',
  'date',
  'from',
  'to',
  'cc',
  'bcc',
  'sender',
  'reply-to',
  'subject',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
  'content-id',
  'return-path',
  'received',
]);

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const ATEXT_WORD_PATTERN = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]*$/;

/** Drops leading and trailing dots and hyphens with a linear scan (the equivalent regex backtracks quadratically). */
function trimDotsAndHyphens(value: string): string {
  const isEdge = (char: string | undefined): boolean => char === '.' || char === '-';
  let start = 0;
  let end = value.length;
  while (start < end && isEdge(value[start])) start++;
  while (end > start && isEdge(value[end - 1])) end--;
  return value.slice(start, end);
}

/**
 * `<random>.<base36 timestamp>@domain`, without angle brackets. The random part
 * is 128 bits, so ids do not collide and cannot be guessed.
 */
export function generateMessageId(domain: string): string {
  const afterAt = domain.slice(domain.lastIndexOf('@') + 1);
  const cleaned = trimDotsAndHyphens(afterAt.trim().toLowerCase().replace(/[^a-z0-9.-]/g, ''));
  if (!cleaned) throw new TypeError('generateMessageId: a domain is required');
  return `${randomHex(16)}.${Date.now().toString(36)}@${cleaned}`;
}

/** Raw RFC 5322 message, CRLF line endings, ready for the SMTP DATA command. */
export function buildMimeMessage(message: OutgoingMessage): string {
  const date = message.date && !Number.isNaN(message.date.getTime()) ? message.date : new Date();

  const headers: string[] = [
    foldHeader('Date', [formatDate(date)]),
    foldHeader('From', addressListChunks([message.from])),
    foldHeader('To', message.to.length > 0 ? addressListChunks(message.to) : ['undisclosed-recipients:;']),
  ];
  if (message.replyTo) headers.push(foldHeader('Reply-To', addressListChunks([message.replyTo])));
  headers.push(foldHeader('Subject', unstructuredChunks(message.subject)));
  headers.push(foldHeader('Message-ID', [formatMessageId(message.messageId)]));
  if (message.inReplyTo) headers.push(foldHeader('In-Reply-To', [formatMessageId(message.inReplyTo)]));
  const references = (message.references ?? []).map(formatMessageIdOrNull).filter((id): id is string => id !== null);
  if (references.length > 0) headers.push(foldHeader('References', references));
  headers.push('MIME-Version: 1.0');
  headers.push(...customHeaders(message.headers));

  const textBody = quotedPrintable(message.text);
  const html = message.html && message.html.trim().length > 0 ? message.html : undefined;

  if (html === undefined) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable');
    return headers.join(CRLF) + CRLF + CRLF + textBody + CRLF;
  }

  const htmlBody = quotedPrintable(html);
  const boundary = pickBoundary([textBody, htmlBody]);
  headers.push(`Content-Type: multipart/alternative;${CRLF} boundary="${boundary}"`);

  const partHeaders = (type: string) =>
    `Content-Type: ${type}; charset=utf-8${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}`;

  return (
    headers.join(CRLF) +
    CRLF +
    CRLF +
    `--${boundary}${CRLF}` +
    partHeaders('text/plain') +
    textBody +
    CRLF +
    `--${boundary}${CRLF}` +
    partHeaders('text/html') +
    htmlBody +
    CRLF +
    `--${boundary}--${CRLF}`
  );
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** `Tue, 14 Nov 2023 22:13:20 +0000` (RFC 5322 date-time, always UTC). */
function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/**
 * Joins `chunks` (indivisible pieces) after `Name:`, wrapping onto a
 * continuation line (CRLF + one space) whenever the next chunk would push the
 * line past 78 characters. A chunk longer than a line stays whole on its own.
 */
function foldHeader(name: string, chunks: string[]): string {
  const lines: string[] = [];
  let current = `${name}:`;
  let hasContent = false;

  for (const chunk of chunks) {
    if (chunk === '') continue;
    if (!hasContent) {
      current += ` ${chunk}`;
      hasContent = true;
    } else if (current.length + 1 + chunk.length <= MAX_LINE_LENGTH) {
      current += ` ${chunk}`;
    } else {
      lines.push(current);
      current = ` ${chunk}`;
    }
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** Control characters and Unicode line separators become spaces, runs of spaces collapse. */
function cleanText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function needsEncoding(text: string): boolean {
  return !PRINTABLE_ASCII_PATTERN.test(text) || /=\?.*\?=/.test(text);
}

function encodeWord(text: string): string {
  return `=?UTF-8?B?${toBase64(utf8(text))}?=`;
}

/** RFC 2047 encoded words for `text`, never splitting a UTF-8 character across two words. */
function encodeAsWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let size = 0;
  for (const character of text) {
    const bytes = utf8(character).length;
    if (size + bytes > MAX_ENCODED_WORD_BYTES) {
      words.push(encodeWord(current));
      current = '';
      size = 0;
    }
    current += character;
    size += bytes;
  }
  if (current) words.push(encodeWord(current));
  return words;
}

/**
 * Free text (subject, custom header values) as foldable chunks. ASCII words
 * stay readable; each run of words that needs it becomes encoded words.
 */
function unstructuredChunks(value: string): string[] {
  const chunks: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) chunks.push(...encodeAsWords(run.join(' ')));
    run = [];
  };

  for (const word of cleanText(value).split(' ')) {
    if (word === '') continue;
    if (needsEncoding(word)) {
      run.push(word);
    } else {
      flush();
      chunks.push(word);
    }
  }
  flush();
  return chunks;
}

function sanitizeEmail(email: string): string {
  const cleaned = email.replace(/[\u0000-\u0020\u007f<>]/g, '');
  if (!cleaned) throw new TypeError('buildMimeMessage: an email address is required');
  return cleaned;
}

/** `name <email>` as chunks: atoms, a quoted string, or RFC 2047 words for non-ASCII names. */
function mailboxChunks(address: MailAddress): string[] {
  const email = sanitizeEmail(address.email);
  const name = address.name ? cleanText(address.name) : '';
  if (!name) return [email];

  const angle = `<${email}>`;
  if (PRINTABLE_ASCII_PATTERN.test(name) && !name.includes('=?')) {
    const words = name.split(' ');
    if (words.every((word) => ATEXT_WORD_PATTERN.test(word))) return [...words, angle];
    const quoted = `"${name.replace(/(["\\])/g, '\\$1')}"`;
    return [...quoted.split(' '), angle];
  }
  return [...encodeAsWords(name), angle];
}

function addressListChunks(addresses: MailAddress[]): string[] {
  const chunks: string[] = [];
  addresses.forEach((address, index) => {
    const parts = mailboxChunks(address);
    if (index < addresses.length - 1) parts[parts.length - 1] += ',';
    chunks.push(...parts);
  });
  return chunks;
}

function cleanMessageId(id: string): string {
  return id.replace(/[^\x21-\x7e]/g, '').replace(/[<>]/g, '');
}

function formatMessageIdOrNull(id: string): string | null {
  const cleaned = cleanMessageId(id);
  return cleaned ? `<${cleaned}>` : null;
}

function formatMessageId(id: string): string {
  const formatted = formatMessageIdOrNull(id);
  if (formatted === null) throw new TypeError('buildMimeMessage: a message id is required');
  return formatted;
}

/** Caller-supplied extra headers, minus anything this builder owns or that is malformed. */
function customHeaders(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  const lines: string[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    if (!HEADER_NAME_PATTERN.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) continue;
    const chunks = unstructuredChunks(rawValue);
    if (chunks.length === 0) continue;
    lines.push(foldHeader(name, chunks));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const HEX = '0123456789ABCDEF';

/**
 * Quoted-printable (RFC 2045): lines at most 76 characters with `=` soft
 * breaks, `=` and non-ASCII escaped, whitespace at the end of a line escaped.
 * Returns CRLF-joined lines without a trailing CRLF.
 */
function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(encodeQuotedPrintableLine).join(CRLF);
}

function encodeQuotedPrintableLine(line: string): string {
  const bytes = utf8(line);
  const tokens: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    const isWhitespace = byte === 0x20 || byte === 0x09;
    const literal = isWhitespace ? i < bytes.length - 1 : byte >= 0x21 && byte <= 0x7e && byte !== 0x3d;
    tokens.push(literal ? String.fromCharCode(byte) : `=${HEX[byte >> 4]}${HEX[byte & 0x0f]}`);
  }

  const out: string[] = [];
  let current = '';
  tokens.forEach((token, index) => {
    // 76 is the limit including a trailing soft-break "=". Only the last
    // token of the line may use the 76th column, since nothing follows it.
    const limit = index === tokens.length - 1 ? 76 : 75;
    if (current.length + token.length > limit) {
      out.push(`${current}=`);
      current = '';
    }
    current += token;
  });
  out.push(current);
  return out.join(CRLF);
}

function pickBoundary(bodies: string[]): string {
  for (;;) {
    const boundary = `_weld_alt_${randomHex(16)}`;
    if (!bodies.some((body) => body.includes(boundary))) return boundary;
  }
}
