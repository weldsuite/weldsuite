import { describe, expect, it } from 'vitest';
import { buildMimeMessage, generateMessageId } from './mime';
import type { OutgoingMessage } from './types';

const FIXED_DATE = new Date(Date.UTC(2023, 10, 14, 22, 13, 20));

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { email: 'jane@getacme.com', name: 'Jane Doe' },
    to: [{ email: 'lead@example.com' }],
    subject: 'Quick question',
    text: 'Hi there,\n\nDo you have a minute?\n',
    messageId: 'abc123@getacme.com',
    date: FIXED_DATE,
    ...overrides,
  };
}

/** Splits a message into unfolded headers (name -> value) and the body. */
function parse(raw: string): { headers: Map<string, string>; rawHeaders: string; body: string } {
  const separator = raw.indexOf('\r\n\r\n');
  const rawHeaders = raw.slice(0, separator);
  const body = raw.slice(separator + 4);
  const headers = new Map<string, string>();
  for (const line of rawHeaders.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, rawHeaders, body };
}

function decodeQuotedPrintable(text: string): string {
  const joined = text.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=') {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Decodes RFC 2047 B-words; whitespace between adjacent encoded words is dropped, as a mail client would. */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(?==\?UTF-8\?B\?)/g, '$1')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g, (_match, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

function longestLine(text: string): number {
  return Math.max(...text.split('\r\n').map((line) => line.length));
}

function hasBareLineFeed(text: string): boolean {
  return /(?<!\r)\n/.test(text) || /\r(?!\n)/.test(text);
}

describe('buildMimeMessage: structure', () => {
  it('builds a plain-text message with the standard headers', () => {
    const raw = buildMimeMessage(message());
    const { headers, body } = parse(raw);

    expect(headers.get('date')).toBe('Tue, 14 Nov 2023 22:13:20 +0000');
    expect(headers.get('from')).toBe('Jane Doe <jane@getacme.com>');
    expect(headers.get('to')).toBe('lead@example.com');
    expect(headers.get('subject')).toBe('Quick question');
    expect(headers.get('message-id')).toBe('<abc123@getacme.com>');
    expect(headers.get('mime-version')).toBe('1.0');
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(headers.get('content-transfer-encoding')).toBe('quoted-printable');
    expect(headers.has('reply-to')).toBe(false);
    expect(headers.has('in-reply-to')).toBe(false);
    expect(headers.has('references')).toBe(false);
    expect(body).toBe('Hi there,\r\n\r\nDo you have a minute?\r\n');
  });

  it('uses CRLF line endings only', () => {
    const raw = buildMimeMessage(
      message({
        text: 'one\ntwo\r\nthree\rfour',
        html: '<p>one</p>\n<p>two</p>',
        subject: 'Zürich   trip',
      }),
    );
    expect(hasBareLineFeed(raw)).toBe(false);
    expect(raw.endsWith('\r\n')).toBe(true);
  });

  it('formats the date as RFC 5322 in UTC and falls back to now for an invalid date', () => {
    expect(parse(buildMimeMessage(message({ date: new Date(Date.UTC(2024, 0, 5, 3, 4, 5)) }))).headers.get('date')).toBe(
      'Fri, 05 Jan 2024 03:04:05 +0000',
    );
    const fallback = parse(buildMimeMessage(message({ date: new Date('nope') }))).headers.get('date');
    expect(fallback).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  });

  it('defaults the date to now', () => {
    const raw = buildMimeMessage({ ...message(), date: undefined });
    expect(parse(raw).headers.get('date')).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} /);
  });

  it('adds Reply-To when given', () => {
    const raw = buildMimeMessage(message({ replyTo: { email: 'replies@getacme.com', name: 'Acme Replies' } }));
    expect(parse(raw).headers.get('reply-to')).toBe('Acme Replies <replies@getacme.com>');
  });

  it('lists several recipients and uses undisclosed-recipients for none', () => {
    const many = buildMimeMessage(
      message({ to: [{ email: 'a@example.com', name: 'A' }, { email: 'b@example.com' }] }),
    );
    expect(parse(many).headers.get('to')).toBe('A <a@example.com>, b@example.com');
    expect(parse(buildMimeMessage(message({ to: [] }))).headers.get('to')).toBe('undisclosed-recipients:;');
  });

  it('normalises angle brackets in message ids', () => {
    const raw = buildMimeMessage(message({ messageId: '<abc@getacme.com>', inReplyTo: ' <parent@x.com> ' }));
    const { headers } = parse(raw);
    expect(headers.get('message-id')).toBe('<abc@getacme.com>');
    expect(headers.get('in-reply-to')).toBe('<parent@x.com>');
  });

  it('rejects a message without an id or a sender address', () => {
    expect(() => buildMimeMessage(message({ messageId: '<>' }))).toThrow(TypeError);
    expect(() => buildMimeMessage(message({ from: { email: '  ' } }))).toThrow(TypeError);
  });
});

describe('buildMimeMessage: threading headers', () => {
  it('sets In-Reply-To and References', () => {
    const raw = buildMimeMessage(
      message({ inReplyTo: 'parent@getacme.com', references: ['root@getacme.com', 'parent@getacme.com'] }),
    );
    const { headers } = parse(raw);
    expect(headers.get('in-reply-to')).toBe('<parent@getacme.com>');
    expect(headers.get('references')).toBe('<root@getacme.com> <parent@getacme.com>');
  });

  it('folds a long References header on message-id boundaries', () => {
    const references = Array.from({ length: 8 }, (_unused, i) => `thread-${i}-0123456789abcdef0123456789@getacme.com`);
    const raw = buildMimeMessage(message({ references }));
    const { headers, rawHeaders } = parse(raw);

    expect(longestLine(rawHeaders)).toBeLessThanOrEqual(78);
    expect(rawHeaders).toMatch(/References: <thread-0[^\r]*>\r\n <thread-/);
    expect(headers.get('references')).toBe(references.map((id) => `<${id}>`).join(' '));
  });

  it('skips empty references', () => {
    const raw = buildMimeMessage(message({ references: ['', '<>', 'ok@x.com'] }));
    expect(parse(raw).headers.get('references')).toBe('<ok@x.com>');
  });
});

describe('buildMimeMessage: non-ASCII headers', () => {
  it('encodes a non-ASCII subject as RFC 2047 words', () => {
    const subject = 'Zürich offer: 20% korting op uw eerste bestelling';
    const raw = buildMimeMessage(message({ subject }));
    const { headers, rawHeaders } = parse(raw);

    expect(rawHeaders).toContain('=?UTF-8?B?');
    expect(rawHeaders).not.toContain('ü');
    expect(decodeWords(headers.get('subject') ?? '')).toBe(subject);
    expect(longestLine(rawHeaders)).toBeLessThanOrEqual(78);
  });

  it('keeps ASCII words of a mixed subject readable', () => {
    const raw = buildMimeMessage(message({ subject: 'Quick question about Café Müller today' }));
    const subject = parse(raw).headers.get('subject') ?? '';
    expect(subject.startsWith('Quick question about =?UTF-8?B?')).toBe(true);
    expect(subject.endsWith(' today')).toBe(true);
    expect(decodeWords(subject)).toBe('Quick question about Café Müller today');
  });

  it('splits a long multi-byte subject without cutting a character in half', () => {
    const subject = '日本語のとても長い件名です。'.repeat(6) + ' 🚀🚀🚀 émoji ' + 'ß'.repeat(60);
    const raw = buildMimeMessage(message({ subject }));
    const { headers, rawHeaders } = parse(raw);

    expect(longestLine(rawHeaders)).toBeLessThanOrEqual(78);
    const words = rawHeaders.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/g) ?? [];
    expect(words.length).toBeGreaterThan(3);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(decodeWords(word)).not.toContain('�');
    }
    expect(decodeWords(headers.get('subject') ?? '')).toBe(subject);
  });

  it('encodes a word that looks like an encoded word', () => {
    const raw = buildMimeMessage(message({ subject: 'Re: =?UTF-8?B?aGk=?= test' }));
    expect(decodeWords(parse(raw).headers.get('subject') ?? '')).toBe('Re: =?UTF-8?B?aGk=?= test');
    expect(parse(raw).rawHeaders).not.toMatch(/Subject: Re: =\?UTF-8\?B\?aGk=\?=/);
  });

  it('folds a long ASCII subject at word boundaries', () => {
    const subject = 'A very long subject line '.repeat(8).trim();
    const raw = buildMimeMessage(message({ subject }));
    const { headers, rawHeaders } = parse(raw);
    expect(longestLine(rawHeaders)).toBeLessThanOrEqual(78);
    expect(rawHeaders).toMatch(/Subject: [^\r]+\r\n [^\r]/);
    expect(headers.get('subject')).toBe(subject);
  });

  it('leaves a plain ASCII display name unquoted', () => {
    expect(parse(buildMimeMessage(message())).headers.get('from')).toBe('Jane Doe <jane@getacme.com>');
  });

  it('quotes a display name with specials and escapes quotes and backslashes', () => {
    const comma = buildMimeMessage(message({ from: { email: 'j@getacme.com', name: 'Doe, Jane' } }));
    expect(parse(comma).headers.get('from')).toBe('"Doe, Jane" <j@getacme.com>');

    const dot = buildMimeMessage(message({ from: { email: 'j@getacme.com', name: 'Jane Q. Doe' } }));
    expect(parse(dot).headers.get('from')).toBe('"Jane Q. Doe" <j@getacme.com>');

    const quotes = buildMimeMessage(message({ from: { email: 'j@getacme.com', name: 'Jane "JD" O\\Brien' } }));
    expect(parse(quotes).headers.get('from')).toBe('"Jane \\"JD\\" O\\\\Brien" <j@getacme.com>');
  });

  it('encodes a non-ASCII display name and keeps the address in angle brackets', () => {
    const raw = buildMimeMessage(message({ from: { email: 'jose@getacme.com', name: 'José Müller, CEO' } }));
    const from = parse(raw).headers.get('from') ?? '';
    expect(from).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <jose@getacme\.com>$/);
    expect(decodeWords(from)).toBe('José Müller, CEO <jose@getacme.com>');
  });

  it('cannot be used to inject headers', () => {
    const raw = buildMimeMessage(
      message({
        subject: 'Hello\r\nBcc: victim@example.com',
        from: { email: 'jane@getacme.com', name: 'Jane\r\nX-Evil: 1' },
        headers: { 'X-Custom': 'value\r\nBcc: victim@example.com' },
      }),
    );
    const { headers } = parse(raw);
    expect(headers.has('bcc')).toBe(false);
    expect(headers.has('x-evil')).toBe(false);
    expect(headers.get('subject')).toBe('Hello Bcc: victim@example.com');
    expect(headers.get('x-custom')).toBe('value Bcc: victim@example.com');
  });
});

describe('buildMimeMessage: custom headers', () => {
  it('adds extra headers such as List-Unsubscribe', () => {
    const raw = buildMimeMessage(
      message({
        headers: {
          'List-Unsubscribe': '<mailto:unsub@getacme.com?subject=unsubscribe>, <https://getacme.com/u/abc123>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    );
    const { headers, rawHeaders } = parse(raw);
    expect(headers.get('list-unsubscribe')).toBe(
      '<mailto:unsub@getacme.com?subject=unsubscribe>, <https://getacme.com/u/abc123>',
    );
    expect(headers.get('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
    expect(longestLine(rawHeaders)).toBeLessThanOrEqual(78);
  });

  it('ignores attempts to override headers the builder owns', () => {
    const raw = buildMimeMessage(
      message({
        headers: {
          'Message-ID': '<evil@x.com>',
          date: 'yesterday',
          FROM: 'evil@x.com',
          To: 'evil@x.com',
          Subject: 'evil',
          'Content-Type': 'text/html',
          'MIME-Version': '2.0',
          Bcc: 'evil@x.com',
          'X-Mailer': 'weld',
        },
      }),
    );
    const { headers, rawHeaders } = parse(raw);
    expect(headers.get('message-id')).toBe('<abc123@getacme.com>');
    expect(headers.get('date')).toBe('Tue, 14 Nov 2023 22:13:20 +0000');
    expect(headers.get('from')).toBe('Jane Doe <jane@getacme.com>');
    expect(headers.get('to')).toBe('lead@example.com');
    expect(headers.get('subject')).toBe('Quick question');
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(headers.get('mime-version')).toBe('1.0');
    expect(headers.has('bcc')).toBe(false);
    expect(headers.get('x-mailer')).toBe('weld');
    expect(rawHeaders.match(/^message-id:/gim)).toHaveLength(1);
    expect(rawHeaders.match(/^date:/gim)).toHaveLength(1);
  });

  it('drops headers with an invalid name or an empty value', () => {
    const raw = buildMimeMessage(message({ headers: { 'Bad Name': 'x', 'X-Colon:': 'x', 'X-Empty': '  ', 'X-Ok': 'yes' } }));
    const { headers } = parse(raw);
    expect(headers.has('bad name')).toBe(false);
    expect(headers.has('x-empty')).toBe(false);
    expect(headers.get('x-ok')).toBe('yes');
  });

  it('encodes non-ASCII values', () => {
    const raw = buildMimeMessage(message({ headers: { 'X-Campaign': 'Zomer kortíng' } }));
    const value = parse(raw).headers.get('x-campaign') ?? '';
    expect(decodeWords(value)).toBe('Zomer kortíng');
    expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
  });
});

describe('buildMimeMessage: quoted-printable bodies', () => {
  const bodyOf = (text: string) => parse(buildMimeMessage(message({ text }))).body;

  it('passes plain ASCII through and escapes =', () => {
    expect(bodyOf('a = b')).toBe('a =3D b\r\n');
  });

  it('escapes non-ASCII as UTF-8 bytes', () => {
    expect(bodyOf('café — 日本')).toBe('caf=C3=A9 =E2=80=94 =E6=97=A5=E6=9C=AC\r\n');
  });

  it('escapes whitespace at the end of a line but not inside it', () => {
    expect(bodyOf('a b \nc\t\nd')).toBe('a b=20\r\nc=09\r\nd\r\n');
  });

  it('keeps blank lines', () => {
    expect(bodyOf('one\n\n\ntwo')).toBe('one\r\n\r\n\r\ntwo\r\n');
  });

  it('wraps long lines with soft breaks of at most 76 characters and round-trips', () => {
    const text = 'word '.repeat(60).trim() + '\n' + 'é'.repeat(90) + '\n' + '='.repeat(100) + '\n' + 'x'.repeat(200);
    const body = bodyOf(text);
    for (const line of body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(body).toContain('=\r\n');
    const decoded = decodeQuotedPrintable(body.replace(/\r\n$/, ''));
    expect(decoded.replace(/\r\n/g, '\n')).toBe(text);
  });

  it('never splits an escape sequence across a soft break', () => {
    for (let padding = 60; padding < 80; padding++) {
      const text = `${'a'.repeat(padding)}é=é=`;
      const body = bodyOf(text);
      for (const line of body.split('\r\n')) {
        expect(line.length).toBeLessThanOrEqual(76);
        // Without the trailing soft-break "=", a line must not end inside an escape like "=C".
        const content = line.endsWith('=') ? line.slice(0, -1) : line;
        expect(content).not.toMatch(/=[0-9A-F]?$/);
      }
      expect(decodeQuotedPrintable(body.replace(/\r\n$/, ''))).toBe(text);
    }
  });

  it('does not add a soft break to a line that is exactly 76 characters', () => {
    const line = 'y'.repeat(76);
    expect(bodyOf(line)).toBe(`${line}\r\n`);
    expect(bodyOf('y'.repeat(77))).toBe(`${'y'.repeat(75)}=\r\nyy\r\n`);
  });

  it('escapes control characters', () => {
    expect(bodyOf('a\u0000b\u000cc')).toBe('a=00b=0Cc\r\n');
  });
});

describe('buildMimeMessage: multipart/alternative', () => {
  const withHtml = () =>
    buildMimeMessage(
      message({ text: 'Plain version é\n', html: '<p>HTML version <b>é</b> = ok</p>\n<p>second</p>' }),
    );

  it('puts text first, then html, between a random boundary', () => {
    const raw = withHtml();
    const { headers, body } = parse(raw);

    const contentType = headers.get('content-type') ?? '';
    const boundary = /boundary="([^"]+)"/.exec(contentType)?.[1];
    expect(contentType.startsWith('multipart/alternative;')).toBe(true);
    expect(boundary).toBeTruthy();
    expect(headers.has('content-transfer-encoding')).toBe(false);

    const parts = body.split(`--${boundary}`);
    // preamble (empty), text part, html part, epilogue after the closing "--"
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('');
    expect(parts[1]).toBe(
      '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPlain version =C3=A9\r\n',
    );
    expect(parts[2]).toBe(
      '\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' +
        '<p>HTML version <b>=C3=A9</b> =3D ok</p>\r\n<p>second</p>\r\n',
    );
    expect(parts[3]).toBe('--\r\n');
  });

  it('uses a fresh boundary per message', () => {
    const boundary = (raw: string) => /boundary="([^"]+)"/.exec(raw)?.[1];
    expect(boundary(withHtml())).not.toBe(boundary(withHtml()));
  });

  it('keeps the boundary out of both bodies', () => {
    const raw = withHtml();
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] ?? '';
    const occurrences = raw.split(boundary).length - 1;
    // header + two opening delimiters + closing delimiter
    expect(occurrences).toBe(4);
  });

  it('keeps every line under the limit and CRLF only', () => {
    const raw = buildMimeMessage(message({ html: `<p>${'long '.repeat(80)}</p>`, text: 'x '.repeat(200) }));
    expect(longestLine(raw)).toBeLessThanOrEqual(78);
    expect(hasBareLineFeed(raw)).toBe(false);
  });

  it('treats a blank html as absent', () => {
    const { headers } = parse(buildMimeMessage(message({ html: '   \n ' })));
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });
});

describe('generateMessageId', () => {
  it('returns <random>.<timestamp>@domain without angle brackets', () => {
    const id = generateMessageId('getacme.com');
    expect(id).toMatch(/^[0-9a-f]{32}\.[0-9a-z]+@getacme\.com$/);
    expect(id).not.toMatch(/[<>]/);
  });

  it('embeds a base36 timestamp of the current time', () => {
    const before = Date.now();
    const id = generateMessageId('getacme.com');
    const stamp = parseInt(id.split('.')[1]?.split('@')[0] ?? '', 36);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateMessageId('getacme.com')));
    expect(ids.size).toBe(1000);
  });

  it('cleans the domain and rejects an empty one', () => {
    expect(generateMessageId('  GetAcme.COM ')).toMatch(/@getacme\.com$/);
    expect(generateMessageId('jane@getacme.com')).toMatch(/@getacme\.com$/);
    expect(generateMessageId('evil.com>\r\nBcc: x')).toMatch(/@evil\.combccx$/);
    expect(() => generateMessageId('  ')).toThrow(TypeError);
    expect(() => generateMessageId('@')).toThrow(TypeError);
  });

  it('works as the messageId of a built message', () => {
    const id = generateMessageId('getacme.com');
    expect(parse(buildMimeMessage(message({ messageId: id }))).headers.get('message-id')).toBe(`<${id}>`);
  });
});
