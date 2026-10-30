/**
 * Mail as the calendar tests read it: what reached the test's `SEND_EMAIL`
 * stub (`createSendEmailStub()` from `@weldsuite/worker-kit/testing/send-email`),
 * one raw RFC 5322 message per envelope, read back here. In conformance mode
 * the stub then holds the Rust backend's messages (built with lettre, where
 * TypeScript uses mimetext), so the reader takes either: unfolded headers,
 * RFC 2047 encoded words, nested multipart, base64 and quoted-printable.
 */

export interface SentMail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Attachments with their content as text (the .ics). */
  attachments: { filename: string; content: string }[];
}

interface StubLike {
  sent: Array<{ from: string; to: string; raw: string }>;
}

function splitHead(raw: string): { head: string; body: string } {
  const text = raw.replace(/\r\n/g, '\n');
  const at = text.indexOf('\n\n');
  return at < 0 ? { head: text, body: '' } : { head: text.slice(0, at), body: text.slice(at + 2) };
}

function headers(head: string): Map<string, string> {
  const out: Array<[string, string]> = [];
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      const last = out[out.length - 1]!;
      last[1] += ` ${line.trim()}`;
      continue;
    }
    const at = line.indexOf(':');
    if (at > 0) out.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
  }
  return new Map(out);
}

function decodeBytes(text: string, encoding: string | undefined): Uint8Array {
  const kind = (encoding ?? '').toLowerCase();
  if (kind === 'base64') return new Uint8Array(Buffer.from(text.replace(/\s+/g, ''), 'base64'));
  if (kind === 'quoted-printable') {
    const joined = text.replace(/=\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < joined.length; i++) {
      const c = joined[i]!;
      if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(...Buffer.from(c, 'utf8'));
      }
    }
    return new Uint8Array(bytes);
  }
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** RFC 2047 encoded words (`=?utf-8?B?…?=`). */
function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _charset: string, kind: string, text: string) =>
      kind.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : new TextDecoder().decode(decodeBytes(text.replace(/_/g, ' '), 'quoted-printable')),
    );
}

function param(value: string | undefined, name: string): string | null {
  if (!value) return null;
  const match = new RegExp(`(?:^|;)\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;]*))`, 'i').exec(value);
  const raw = match ? (match[1] ?? match[2] ?? '').trim() : null;
  return raw === null ? null : decodeWords(raw.replace(/^utf-8''/i, ''));
}

interface Part {
  type: string;
  filename: string | null;
  text: string;
}

function parts(head: string, body: string): Part[] {
  const map = headers(head);
  const contentType = map.get('content-type') ?? 'text/plain';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(contentType, 'boundary');
    if (!boundary) return [];
    const out: Part[] = [];
    for (const section of body.split(`--${boundary}`).slice(1)) {
      if (section.startsWith('--')) break;
      const inner = splitHead(section.replace(/^\n/, '').replace(/\n$/, ''));
      out.push(...parts(inner.head, inner.body));
    }
    return out;
  }
  const filename = param(map.get('content-disposition'), 'filename') ?? param(contentType, 'name');
  const text = new TextDecoder().decode(decodeBytes(body, map.get('content-transfer-encoding')));
  return [{ type, filename, text: trimTrailingNewlines(text.replace(/\r\n/g, '\n')) }];
}

/** `text` without its trailing newlines. */
function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end--;
  return text.slice(0, end);
}

function readOne(raw: string, to: string): SentMail {
  const { head, body } = splitHead(raw);
  const map = headers(head);
  const leaves = parts(head, body);
  const inline = (type: string) => leaves.find((p) => p.type === type && !p.filename)?.text ?? '';
  return {
    to: [to],
    subject: decodeWords(map.get('subject') ?? ''),
    html: inline('text/html'),
    text: inline('text/plain'),
    attachments: leaves
      .filter((p) => p.filename)
      .map((p) => ({ filename: p.filename!, content: p.text })),
  };
}

/** Every message the stub took, one per envelope, in order. */
export function readSent(stub: StubLike | null): SentMail[] {
  return (stub?.sent ?? []).map((m) => readOne(m.raw, m.to));
}
