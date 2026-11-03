/**
 * Customer mail in conformance mode: what a send handed to the `SEND_EMAIL`
 * binding (one envelope and a raw RFC 5322 message), read back the way a mail
 * client reads it, so the two backends' messages compare equal when they say
 * the same thing. The TypeScript side builds MIME with mimetext, the Rust
 * side with lettre: header folding, boundaries, transfer encodings and the
 * Date differ by construction; senders, recipients, subject, threading
 * headers, the Message-ID's form and the parts do not (ADR MAIL-010).
 *
 * A small reader on purpose (no dependency): unfolded headers, RFC 2047
 * encoded words, address lists, multipart bodies, base64 and
 * quoted-printable.
 */

/** One envelope as compared. */
export interface SendRecord {
  envelope: { from: string; to: string };
  from: { email: string; name: string | null } | null;
  to: string[];
  cc: string[];
  replyTo: string | null;
  subject: string;
  /** `<32 hex@domain>` → `<hex32@domain>`; anything else as it is. */
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
  /** Other headers a send path sets (`X-Priority`, …), by lower-cased name. */
  headers: Record<string, string>;
  parts: Array<{ type: string; filename: string | null; text: string | null; size: number }>;
}

/** Headers every builder writes, or writes its own way: not compared. */
const STRUCTURAL = new Set([
  'date',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
  'content-id',
  'message-id',
  'from',
  'to',
  'cc',
  'reply-to',
  'subject',
  'in-reply-to',
  'references',
]);

function splitHead(raw: string): { head: string; body: string } {
  const text = raw.replace(/\r\n/g, '\n');
  const at = text.indexOf('\n\n');
  return at < 0 ? { head: text, body: '' } : { head: text.slice(0, at), body: text.slice(at + 2) };
}

function parseHeaders(head: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      const last = out[out.length - 1]!;
      last[1] = `${last[1]} ${line.trim()}`;
    } else {
      const colon = line.indexOf(':');
      if (colon > 0) out.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
    }
  }
  return out;
}

function decodeQ(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '_') bytes.push(0x20);
    else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0));
  }
  return new Uint8Array(bytes);
}

/** RFC 2047: `=?utf-8?B?…?=` and `=?utf-8?Q?…?=`, adjacent words joined. */
export function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _charset: string, encoding: string, text: string) => {
      const bytes = encoding.toUpperCase() === 'B' ? new Uint8Array(Buffer.from(text, 'base64')) : decodeQ(text);
      return new TextDecoder().decode(bytes);
    });
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

/** `"Name" <a@b>, <c@d>, e@f` → each address with its name. */
export function parseAddresses(value: string | undefined): Array<{ email: string; name: string | null }> {
  if (!value) return [];
  const items: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const c of value) {
    if (c === '"') quoted = !quoted;
    else if (c === '<' && !quoted) angle = true;
    else if (c === '>' && !quoted) angle = false;
    if (c === ',' && !quoted && !angle) {
      items.push(current);
      current = '';
    } else current += c;
  }
  items.push(current);
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const open = item.lastIndexOf('<');
      if (open >= 0 && item.endsWith('>')) {
        const name = decodeWords(unquote(item.slice(0, open)));
        return { email: item.slice(open + 1, -1).trim().toLowerCase(), name: name || null };
      }
      return { email: item.toLowerCase(), name: null };
    });
}

function param(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const match = new RegExp(`${name}\\*?=("([^"]*)"|[^;\\s]+)`, 'i').exec(header);
  if (!match) return null;
  const value = match[2] ?? match[1]!;
  // RFC 2231 `name*=utf-8''…`
  const extended = /^([^']*)'[^']*'(.*)$/.exec(value);
  return decodeWords(extended ? decodeURIComponent(extended[2]!) : value);
}

function decodeBody(body: string, encoding: string | undefined): Uint8Array {
  switch ((encoding ?? '').toLowerCase()) {
    case 'base64':
      return new Uint8Array(Buffer.from(body.replace(/\s+/g, ''), 'base64'));
    case 'quoted-printable': {
      const joined = body.replace(/=\n/g, '');
      const bytes: number[] = [];
      for (let i = 0; i < joined.length; i++) {
        const c = joined[i]!;
        if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
          bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(...new TextEncoder().encode(c));
      }
      return new Uint8Array(bytes);
    }
    default:
      return new TextEncoder().encode(body);
  }
}

type Part = SendRecord['parts'][number];

function leafParts(head: string, body: string): Part[] {
  const headers = new Map(parseHeaders(head));
  const contentType = headers.get('content-type') ?? 'text/plain';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(contentType, 'boundary');
    if (!boundary) return [];
    const sections = body.split(`--${boundary}`);
    const parts: Part[] = [];
    for (const section of sections.slice(1)) {
      if (section.startsWith('--')) break;
      // The line break before a delimiter belongs to the delimiter.
      const inner = splitHead(section.replace(/^\n/, '').replace(/\n$/, ''));
      parts.push(...leafParts(inner.head, inner.body));
    }
    return parts;
  }
  const bytes = decodeBody(body, headers.get('content-transfer-encoding'));
  const disposition = headers.get('content-disposition');
  const filename = param(disposition, 'filename') ?? param(contentType, 'name');
  const isText = type.startsWith('text/') && !filename;
  return [
    {
      type,
      filename,
      // Line endings and the trailing newline a builder adds are not content.
      text: isText ? withoutTrailingNewlines(new TextDecoder().decode(bytes).replace(/\r\n/g, '\n')) : null,
      size: isText ? 0 : bytes.byteLength,
    },
  ];
}

function withoutTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end--;
  return text.slice(0, end);
}

function rawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
  return String(raw);
}

/**
 * Masks what differs per run by construction, as system mail does
 * (./conformance-mail.ts): a sign-in link's token, a six-digit code.
 */
function maskRandom(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{20,}/g, '<token>').replace(/\b\d{6}\b/g, '<code>');
}

/** One envelope as compared: what a recipient's client would show. */
export function sendRecord(from: string, to: string, raw: unknown): SendRecord {
  const { head, body } = splitHead(rawText(raw));
  const headers = parseHeaders(head);
  const get = (name: string) => headers.find(([key]) => key === name)?.[1];
  const sender = parseAddresses(get('from'))[0] ?? null;
  const messageId = (get('message-id') ?? '').replace(/^<[0-9a-f]{32}@/, '<hex32@');
  const extra: Record<string, string> = {};
  for (const [key, value] of headers) if (!STRUCTURAL.has(key)) extra[key] = decodeWords(value);
  return {
    envelope: { from, to: to.toLowerCase() },
    from: sender,
    to: parseAddresses(get('to')).map((a) => a.email),
    cc: parseAddresses(get('cc')).map((a) => a.email),
    replyTo: parseAddresses(get('reply-to'))[0]?.email ?? null,
    subject: maskRandom(decodeWords(get('subject') ?? '')),
    messageId,
    inReplyTo: get('in-reply-to') ?? null,
    references: get('references')?.replace(/\s+/g, ' ') ?? null,
    headers: extra,
    parts: leafParts(head, body).map((part) => ({ ...part, text: part.text === null ? null : maskRandom(part.text) })),
  };
}
