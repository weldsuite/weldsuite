/**
 * Parity fixtures for the Rust port of mail-inbound-worker
 * (`rust/crates/mail-inbound`, the `mail.inbound` subscriber of
 * `weldsuite consume`, ADR MAIL-010).
 *
 * Runs the worker's own code on the inputs its tests use (and a few more)
 * and writes what it did: how a raw message parses (`adaptCloudflareEmail`
 * over postal-mime, with the `Authentication-Results` read), the spam and
 * promotion scores, the thread-matching and other pure helpers, and, on
 * pglite, the rows `storeEmail` (Postgres mailbox store), the mail rules and
 * `ingestDeskEmail` write. The Rust tests
 * (`rust/crates/mail-inbound/tests/parity.rs`) feed the same inputs to the
 * port and compare, so the expectations come from TypeScript.
 *
 *   pnpm rust:mail-inbound-fixtures            write the fixtures
 *   pnpm rust:mail-inbound-fixtures --check    exit 1 when one is stale
 *
 * Values that differ on every run (generated ids, the time now, a random
 * Message-ID) are replaced by placeholders on both sides.
 */
import { register } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `new Date(…)` without a zone is local time: a worker runs in UTC, and its
// default locale (postal-mime's `Intl.DateTimeFormat('default', …)` for a
// forwarded message's header) is en-US, whatever this machine's is.
process.env.TZ = 'UTC';
{
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  // A function, not an arrow: postal-mime calls it with `new`.
  const workerDateTimeFormat = function (locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new NativeDateTimeFormat(locale === 'default' ? 'en-US' : locale, options);
  };
  Object.assign(workerDateTimeFormat, NativeDateTimeFormat);
  (Intl as { DateTimeFormat: unknown }).DateTimeFormat = workerDateTimeFormat;
}

// The Workers-only modules the worker's imports reach (send bindings, the
// mailbox Durable Object): stubs, as the worker's vitest config has.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:email') {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export class EmailMessage { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } }') };
  }
  if (specifier === 'cloudflare:workers') {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(c, e) { this.ctx = c; this.env = e; } } export class WorkflowEntrypoint { constructor(c, e) { this.ctx = c; this.env = e; } } export class WorkerEntrypoint {} export const env = {};') };
  }
  return next(specifier, context);
}`)}`,
  import.meta.url,
);

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'rust', 'crates', 'mail-inbound', 'tests', 'fixtures');
const check = process.argv.includes('--check');
const worker = (file: string) => `../apps/workers/mail-inbound-worker/src/lib/${file}`;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Runs `work` with the worker's console output silenced. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => undefined;
  try {
    return await work();
  } finally {
    Object.assign(console, saved);
  }
}

function crlf(lines: string[]): string {
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Raw messages
// ---------------------------------------------------------------------------

interface RawCase {
  name: string;
  raw: Uint8Array;
  envelopeTo: string[];
}

const utf8 = (text: string) => new TextEncoder().encode(text);
/** A message with 8-bit bytes in a legacy charset. */
function latin1(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0xff));
}

const RAW_CASES: RawCase[] = [
  {
    // cf-email-adapter.test.ts's message.
    name: 'adapter-plain',
    envelopeTo: ['recipient@example.com'],
    raw: utf8(
      crlf([
        'From: Sender <sender@example.com>',
        'To: Recipient <recipient@example.com>',
        'Subject: Hello',
        'Message-ID: <abc123@example.com>',
        '',
        'Body text.',
        '',
      ]),
    ),
  },
  {
    name: 'alternative-qp-encoded-words',
    envelopeTo: ['inbox@acme.test', 'bcc-only@acme.test'],
    raw: utf8(
      crlf([
        'Authentication-Results: mx.weldsuite.test; spf=pass smtp.mailfrom=jorg@partner.test; dkim=pass header.d=partner.test; dmarc=pass header.from=partner.test',
        'From: =?ISO-8859-1?Q?J=F6rg_M=FCller?= <jorg@partner.test>',
        'To: "Inbox, Acme" <inbox@acme.test>, ops@acme.test',
        'Cc: Ann <ann@acme.test>, "Bob B." <bob@acme.test>',
        'Reply-To: Collector <collector@elsewhere.test>',
        'Subject: =?UTF-8?B?UmU6IEPDtHTDqQ==?= =?UTF-8?Q?_du_lundi?=',
        'Date: Tue, 27 Oct 2026 09:15:00 +0100 (CET)',
        'Message-ID: <alt-1@partner.test>',
        'In-Reply-To: <root@acme.test>',
        'References: <root@acme.test>\r\n <second@partner.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="b1"',
        '',
        'preamble',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Caf=C3=A9 au lait =',
        'and more',
        '--b1',
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        '<p>Caf=C3=A9 <b>au</b> lait</p><script>alert(1)</script>',
        '--b1--',
        'epilogue',
        '',
      ]),
    ),
  },
  {
    name: 'mixed-related-attachments',
    envelopeTo: ['inbox@acme.test'],
    raw: utf8(
      crlf([
        'Authentication-Results: mx.weldsuite.test; spf=softfail smtp.mailfrom=x@bad.test; dkim=fail header.d=bad.test; dmarc=fail header.from=bad.test',
        'Authentication-Results: other.test; spf=pass',
        'From: Billing <billing@vendor.test>',
        'To: inbox@acme.test',
        'Subject: Invoice 42',
        'Date: 2026-10-28T10:00:00Z',
        'Message-ID: <mixed-1@vendor.test>',
        'Content-Type: multipart/mixed; boundary="outer"',
        '',
        '--outer',
        'Content-Type: multipart/related; boundary="rel"',
        '',
        '--rel',
        'Content-Type: text/html; charset="us-ascii"',
        '',
        '<html><body><img src="cid:logo001@vendor"><p>See attached &amp; pay.</p></body></html>',
        '--rel',
        'Content-Type: image/png; name="logo.png"',
        'Content-Transfer-Encoding: base64',
        'Content-ID: <logo001@vendor>',
        'Content-Disposition: inline; filename="logo.png"',
        '',
        'iVBORw0KGgo=',
        '--rel--',
        '--outer',
        'Content-Type: application/octet-stream',
        'Content-Transfer-Encoding: base64',
        "Content-Disposition: attachment; filename*=UTF-8''factuur%20nr%C2%BA42.pdf",
        '',
        'JVBERi0xLjQK',
        'JSVFT0YK',
        '--outer',
        'Content-Type: application/x-msdownload; name="setup.exe"',
        'Content-Transfer-Encoding: base64',
        '',
        'TVqQ',
        '--outer--',
        '',
      ]),
    ),
  },
  {
    name: 'html-only',
    envelopeTo: ['inbox@acme.test'],
    raw: utf8(
      crlf([
        'From: "Shop" <news@shop.test>',
        'To: inbox@acme.test',
        'Subject: Summer SALE: 30% off everything',
        'Date: Wed, 28 Oct 2026 08:00:00 GMT',
        'Message-ID: <promo-1@shop.test>',
        'List-Unsubscribe: <mailto:unsub@shop.test?subject=unsubscribe>, <https://shop.test/u?id=1>',
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        'List-Id: Shop News <news.shop.test>',
        'Precedence: bulk',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<!DOCTYPE html><html><head><title>x</title></head><body>',
        '<h1>Big &amp; bold &eacute;t&eacute; &#8364;5</h1><br><ul><li> one</li><li>two</li></ul>',
        '<a href="https://shop.test/a">Shop now</a> <hr> Unsubscribe <!-- note -->',
        '</body></html>',
        '',
      ]),
    ),
  },
  {
    name: 'latin1-8bit-folded',
    envelopeTo: ['inbox@acme.test'],
    raw: latin1(
      crlf([
        'From: =?iso-8859-1?q?Andr=E9?= <andre@partner.test>',
        'To: inbox@acme.test',
        'Subject: A long subject that was',
        '\tfolded over two lines',
        'Date: Thu, 29 Oct 26 07:00:00 EST',
        'Message-ID: <latin-1@partner.test>',
        'Content-Type: text/plain; charset=ISO-8859-1',
        'Content-Transfer-Encoding: 8bit',
        '',
        'Voilà, déjà vu.',
        '',
      ]),
    ),
  },
  {
    name: 'no-message-id-no-date',
    envelopeTo: ['inbox@acme.test'],
    raw: utf8(crlf(['From: someone@nowhere.test', 'To: inbox@acme.test', 'Subject: (no id)', '', 'hi', ''])),
  },
  {
    name: 'invalid-date',
    envelopeTo: ['inbox@acme.test'],
    raw: utf8(
      crlf([
        'From: a@b.test',
        'To: inbox@acme.test',
        'Subject: Zone',
        'Date: Mon, 26 Oct 2026 12:00:00 CEST',
        'Message-ID: <zone@b.test>',
        '',
        'x',
      ]),
    ),
  },
  {
    name: 'flowed-and-calendar',
    envelopeTo: ['inbox@acme.test'],
    raw: utf8(
      crlf([
        'From: Cal <cal@partner.test>',
        'To: inbox@acme.test',
        'Subject: Invitation',
        'Date: Fri, 30 Oct 2026 16:45:12 -0700',
        'Message-ID: <cal-1@partner.test>',
        'Content-Type: multipart/mixed; boundary=mixed',
        '',
        '--mixed',
        'Content-Type: text/plain; charset=utf-8; format=flowed; delsp=yes',
        '',
        'This line is soft- ',
        'wrapped and ',
        ' stuffed.',
        '-- ',
        'sig',
        '--mixed',
        'Content-Type: text/calendar; method=request; charset=utf-8',
        '',
        'BEGIN:VCALENDAR',
        'END:VCALENDAR',
        '',
        '',
        '--mixed--',
      ]),
    ),
  },
  {
    name: 'inline-rfc822-forward',
    envelopeTo: ['inbox@acme.test'],
    raw: utf8(
      crlf([
        'From: Fwd <fwd@acme.test>',
        'To: inbox@acme.test',
        'Subject: Fwd: Original',
        'Date: Sat, 31 Oct 2026 11:00:00 +0000',
        'Message-ID: <fwd-1@acme.test>',
        'Content-Type: multipart/mixed; boundary=m2',
        '',
        '--m2',
        'Content-Type: text/plain',
        '',
        'See below.',
        '--m2',
        'Content-Type: message/rfc822',
        '',
        'From: Orig <orig@partner.test>',
        'To: fwd@acme.test',
        'Subject: Original',
        'Date: Fri, 30 Oct 2026 10:00:00 +0000',
        '',
        'The original body.',
        '--m2--',
        '',
      ]),
    ),
  },
  {
    name: 'groups-and-odd-addresses',
    envelopeTo: ['inbox@acme.test'],
    raw: utf8(
      crlf([
        'From: support@weldmail.test <evil@phish.test>',
        'To: Undisclosed recipients:;',
        'To: Team: a@acme.test, "B" <b@acme.test>;, plain@acme.test (Plain Person)',
        'Cc: =?utf-8?B?w6l0w6k=?= <ete@acme.test>',
        'Subject: First subject',
        'Subject: Second subject wins',
        'Date: Sun, 1 Nov 2026 00:00:00 +0000',
        'Message-ID: <groups@phish.test>',
        '',
        'Visit http://bit.ly/abc and https://a.test https://b.test https://c.test https://d.test',
      ]),
    ),
  },
  {
    name: 'windows-1252-and-unknown-charset',
    envelopeTo: ['inbox@acme.test'],
    raw: latin1(
      crlf([
        'From: x@y.test',
        'To: inbox@acme.test',
        'Subject: =?x-unknown?Q?caf=E9?=',
        'Message-ID: <cs@y.test>',
        'Date: Mon, 2 Nov 2026 10:00:00 +0000',
        'Content-Type: multipart/alternative; boundary=zz',
        '',
        '--zz',
        'Content-Type: text/plain; charset=windows-1252',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Price: =80 5 =E9',
        '--zz',
        'Content-Type: text/html; charset=bogus-charset',
        '',
        '<p>été</p>',
        '--zz--',
      ]),
    ),
  },
];

const b64 = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The Cloudflare message for a raw message: its headers as Email Routing hands them over. */
async function fakeMessage(raw: Uint8Array, to: string) {
  const { default: PostalMime } = await import('postal-mime');
  const parsed = await PostalMime.parse(raw);
  const headers = new Headers();
  for (const h of parsed.headers ?? []) {
    if (h.key !== 'authentication-results') continue;
    try {
      headers.append(h.key, h.value);
    } catch {
      // A value Headers refuses never reaches the worker either.
    }
  }
  return {
    from: 'envelope@sender.test',
    to,
    raw: streamOf(raw),
    headers,
    rawSize: raw.byteLength,
    setReject: () => undefined,
    forward: async () => undefined,
  };
}

const RANDOM_ID = /^<[0-9a-f]{32}@weldmail\.local>$/;

/** A parsed email as the fixture records it. */
function emailJson(email: Record<string, unknown>, datePresent: boolean): Json {
  const receivedAt = email.receivedAt as Date;
  return {
    messageId: RANDOM_ID.test(String(email.messageId)) ? '<random>' : (email.messageId as string),
    from: email.from as Json,
    to: email.to as Json,
    cc: email.cc as Json,
    envelopeTo: email.envelopeTo as Json,
    subject: email.subject as string,
    textBody: (email.textBody ?? null) as Json,
    htmlBody: (email.htmlBody ?? null) as Json,
    headers: Object.entries(email.headers as Record<string, string>) as Json,
    receivedAt: datePresent ? receivedAt.toISOString() : '<now>',
    hasAttachments: email.hasAttachments as boolean,
    attachmentCount: email.attachmentCount as number,
    inReplyTo: (email.inReplyTo ?? null) as Json,
    references: (email.references ?? null) as Json,
    spfStatus: (email.spfStatus ?? null) as Json,
    dkimStatus: (email.dkimStatus ?? null) as Json,
    dmarcStatus: (email.dmarcStatus ?? null) as Json,
  };
}

async function parseFixture(): Promise<Json> {
  const { adaptCloudflareEmail } = await import(worker('cf-email-adapter'));
  const { default: PostalMime } = await import('postal-mime');
  const cases: Json[] = [];
  for (const c of RAW_CASES) {
    const postal = await PostalMime.parse(c.raw);
    const date = postal.date ? new Date(postal.date) : null;
    const datePresent = Boolean(date && !Number.isNaN(date.getTime()));
    const message = await fakeMessage(c.raw, c.envelopeTo[0]!);
    const { email, attachments } = await adaptCloudflareEmail(message);
    // Cloudflare calls the worker once per envelope recipient; Haraka hands
    // over all of them at once. The parse is the same; only the envelope
    // list differs, so record all of them.
    email.envelopeTo = c.envelopeTo;
    cases.push({
      name: c.name,
      raw: b64(c.raw),
      envelopeTo: c.envelopeTo,
      email: emailJson(email, datePresent),
      attachments: attachments.map((a: { fileName: string; contentType: string; content: Uint8Array; contentId?: string }) => ({
        fileName: a.fileName,
        contentType: a.contentType,
        content: b64(a.content),
        contentId: a.contentId ?? null,
      })),
    });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Spam and promotions (spam-filter.test.ts, promotion-filter.test.ts)
// ---------------------------------------------------------------------------

function spamBase(overrides: Record<string, unknown> = {}) {
  return {
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'me@weldmail.com' }],
    subject: 'Project update',
    textBody: 'Here is the weekly status. Nothing urgent.',
    htmlBody: null,
    headers: {},
    spfStatus: 'pass',
    dkimStatus: 'pass',
    dmarcStatus: 'pass',
    ...overrides,
  };
}

async function spamFixture(): Promise<Json> {
  const { scoreInboundSpam } = await import(worker('spam-filter'));
  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [spamBase(), {}],
    [spamBase({ spfStatus: 'fail', dkimStatus: 'fail', dmarcStatus: 'fail' }), {}],
    [spamBase({ spfStatus: undefined, dkimStatus: undefined, dmarcStatus: undefined }), {}],
    [spamBase(), { attachmentNames: ['invoice.pdf', 'payload.exe'] }],
    [spamBase({ subject: 'You won the lottery jackpot!!!' }), {}],
    [spamBase({ from: { email: 'evil@phish.example', name: 'support@weldmail.com' } }), { recipientEmails: ['me@weldmail.com'] }],
    [spamBase({ headers: { 'Reply-To': 'collector@evil.example' } }), {}],
    [
      spamBase({
        subject: 'CLAIM YOUR PRIZE NOW!!!',
        spfStatus: 'fail',
        dkimStatus: 'none',
        dmarcStatus: 'none',
        textBody: 'http://a.com http://b.com http://c.com http://d.com http://e.com click',
      }),
      { attachmentNames: ['update.js'] },
    ],
    [spamBase({ spfStatus: 'fail', dkimStatus: 'fail', dmarcStatus: 'fail', subject: 'URGENT WIRE TRANSFER!!!' }), { isExistingHamThread: true }],
    [spamBase({ spfStatus: 'softfail' }), { isExistingHamThread: true }],
    [
      spamBase({
        from: { email: 'donotreplyus@inbox.lv', name: 'American Express | Non-Compliance Issues' },
        to: [{ email: 'sales@weldsuite.org' }],
        subject: 'Account Limited: Update Information to Continue Access',
      }),
      {},
    ],
    [spamBase({ from: { email: 'x@gmail.com', name: 'PAYPAL-Security' } }), {}],
    [spamBase({ from: { email: 'x@gmail.com', name: 'Amazonia Tours' } }), {}],
    [spamBase({ from: { email: 'service@paypal.com', name: 'PayPal' } }), {}],
    [spamBase({ from: { email: 'jan.devries@gmail.com', name: 'Jan de Vries' } }), {}],
    [spamBase({ from: { email: 'x@gmail.com', name: 'Jan (Amazon seller)' } }), { isExistingHamThread: true }],
    // More than the worker's tests: shorteners, embedded addresses, HTML links.
    [spamBase({ textBody: 'see https://www.Bit.ly/x', htmlBody: '<a href="https://t.co/y">y</a>' }), {}],
    [spamBase({ from: { email: 'real@corp.test', name: 'Helpdesk billing@bank.test' } }), {}],
    [spamBase({ from: { email: 'real@corp.test', name: 'noreply team' } }), { recipientEmails: [] }],
    [spamBase({ subject: 'GRATIS GELD', textBody: null, htmlBody: null }), { attachmentNames: ['dir\\Run.BAT'] }],
    [spamBase({ headers: { 'reply-to': '"X" <x@Example.com>' }, from: { email: 'alice@EXAMPLE.com' } }), {}],
  ];
  return cases.map(([email, options]) => ({ email: email as Json, options: options as Json, result: scoreInboundSpam(email, options) }));
}

function promoBase(overrides: Record<string, unknown> = {}) {
  return { subject: 'Project update', textBody: 'Here is the weekly status. Nothing urgent.', htmlBody: null, headers: {}, ...overrides };
}

async function promotionFixture(): Promise<Json> {
  const { classifyPromotion } = await import(worker('promotion-filter'));
  const bulk = { 'List-Unsubscribe': '<https://shop.example.com/unsub?u=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [promoBase(), {}],
    [promoBase({ subject: 'Summer SALE: 30% off everything', textBody: 'Shop now. Unsubscribe here.', headers: bulk }), {}],
    [promoBase({ subject: 'Onze nieuwsbrief van september', textBody: 'Klik hier om je af te melden: afmelden', headers: { 'X-Mailin-Campaign': '42' } }), {}],
    [promoBase({ subject: 'Deal update for Acme', textBody: 'Can we discuss the discount?' }), {}],
    [promoBase({ subject: 'Your order confirmation #1234', textBody: 'Thanks for your purchase. Unsubscribe from marketing.', headers: { ...bulk, Precedence: 'bulk' } }), {}],
    [promoBase({ subject: 'Re: 50% off', headers: bulk }), { isReply: true }],
    [promoBase({ subject: 'Wholesale pricing from Salesforce', headers: { 'List-Unsubscribe': '<mailto:x@y.z>' } }), {}],
    [promoBase({ subject: 'Black Friday deals', headers: { 'list-unsubscribe': '<mailto:u@x.com>', precedence: 'Bulk' } }), {}],
    [promoBase({ subject: 'Laatste kans: korting!', htmlBody: '<p>Opt-out</p>', headers: { 'x-list-id': 'x' } }), {}],
    [promoBase({ subject: 'éSALE', textBody: 'unsubscribe' }), {}],
  ];
  return cases.map(([email, options]) => ({ email: email as Json, options: options as Json, result: classifyPromotion(email, options) }));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

async function helpersFixture(): Promise<Json> {
  const tm = await import('../packages/domains/mail/src/store/thread-match');
  const catchAll = await import(worker('catch-all'));
  const { selectNotifyMembers } = await import(worker('notify-recipients'));
  const { accountingAttachmentType } = await import(worker('accounting-attachment'));
  const { parseListUnsubscribe } = await import('../packages/core/email/src/list-unsubscribe');
  const desk = await import(worker('desk-inbound'));
  const deskLib = await import('../packages/core/db/src/lib/desk');
  const ids = ['<abc@x.test>', 'def@y.test', '<abc@x.test>', '', ' < spaced@z.test > ', '<<double>>', 'no-at'];
  const subjects = [
    'Re: RE: Fwd: Quarterly numbers',
    'AW: Re[2]: Hello',
    'Fw:Hello',
    'Revenue: Q3',
    'Re:',
    'Reminder: invoice',
    'antw : Klaar',
    'sv:vs: Hej',
    'fwdx: no',
    '  Re :  spaced  ',
    '',
  ];
  const stored = { from: { email: 'Me@Weldmail.example', name: 'Me' }, to: [{ email: 'support@helpdesk.example' }], cc: null };
  const members = [
    { userId: 'u1', role: 'MEMBER' },
    { userId: 'u2', role: 'admin' },
    { userId: 'u3', role: 'OWNER' },
    { userId: 'u4', role: null },
  ];
  const att = (fileName: string, contentType: string, size: number, contentId?: string) => ({
    fileName,
    contentType,
    content: new Uint8Array(size),
    ...(contentId ? { contentId } : {}),
  });
  const deskFiles = [
    att('logo.png', 'image/png', 3, '<LOGO@x>'),
    att('a.pdf', 'application/pdf', 2),
    att('empty.txt', 'text/plain', 0),
    att('b.html', 'text/html; charset=utf-8', 4, '<b@x>'),
  ];
  const unsubscribeHeaders: Array<Record<string, string>> = [
    { 'list-unsubscribe': '<mailto:u@x.com?subject=unsub>, <https://shop.example.com/u?u=1>', 'list-unsubscribe-post': 'List-Unsubscribe=One-Click', 'list-id': 'Shop <news.shop.example.com>' },
    { 'list-unsubscribe': '<http://plain.example.com>' },
    { 'list-unsubscribe': 'https://bare.example.com/u, mailto:bad' },
    { 'List-Unsubscribe': '<https://127.0.0.1/u>, <mailto:a@b.co>', 'List-Id': '  raw-list  ' },
    { 'list-unsubscribe': '<https://intranet.local/u>' },
    {},
  ];
  return {
    bareMessageId: ids.map((id) => [id, tm.bareMessageId(id)]),
    messageIdVariants: tm.messageIdVariants(ids),
    providerMessageIds: tm.providerMessageIds(['<abc-123@eu-west-1.amazonses.com>', 'abc-123@other.test', 'plain', '<@x>']),
    subjects: subjects.map((s) => ({ subject: s, bare: tm.bareSubject(s), reply: tm.hasReplyPrefix(s), conversation: tm.conversationSubjects(s) })),
    involves: ['support@HELPDESK.example', 'me@weldmail.example', 'stranger@elsewhere.example', ''].map((a) => [a, tm.involvesAddress(stored, a || undefined)]),
    catchAll: catchAll.expandCatchAllCandidates(
      ['Hello@Acme.example', 'random@acme.example', 'x@team.weldmail.com', 'nobody', '@x', 'y@', 'z@Other.Test'],
      new Set(['hello@acme.example']),
    ),
    notifyMembers: [
      selectNotifyMembers({ isShared: true, assignedUserIds: null }, members).map((m: { userId: string }) => m.userId),
      selectNotifyMembers({ isShared: false, assignedUserIds: [] }, members).map((m: { userId: string }) => m.userId),
      selectNotifyMembers({ isShared: null, assignedUserIds: ['u4', 'u9'] }, members).map((m: { userId: string }) => m.userId),
    ],
    accountingTypes: [
      ['application/pdf', 'a'],
      ['application/octet-stream', 'Inv.PDF'],
      ['IMAGE/PNG; x=y', 'a'],
      ['text/plain', 'a.pdf'],
      ['', 'x.pdf'],
    ].map(([contentType, fileName]) => [contentType!, fileName!, accountingAttachmentType({ contentType: contentType!, fileName: fileName! })]),
    listUnsubscribe: unsubscribeHeaders.map((headers) => ({ headers: Object.entries(headers), result: parseListUnsubscribe(headers) as Json })),
    deskAttachments: desk.selectDeskAttachments(deskFiles, '<img src="cid:logo@X"><img src=cid:b%40x>').map((a: { fileName: string }) => a.fileName),
    storedFileMetadata: [
      ['image/PNG', 'a.png'],
      ['text/html; charset=utf-8', 'x.html'],
      ['', 'y'],
    ].map(([t, n]) => [t!, n!, desk.storedFileMetadata(t, n!) as Json]),
    plans: [
      [true, null, null],
      [false, 'u1', null],
      [false, null, { state: 'open', waitingSince: new Date(0) }],
      [false, null, { state: 'open', waitingSince: null }],
      [false, null, { state: 'closed', waitingSince: new Date(0) }],
    ].map(([created, assigneeId, prior]) => [
      created as boolean,
      assigneeId as Json,
      prior ? (prior as { state: string; waitingSince: Date | null }).waitingSince !== null && (prior as { state: string }).state === 'open' : null,
      prior ? (prior as { state: string }).state : null,
      desk.planDeskNotification({ created: created as boolean, assigneeId: assigneeId as string | null, prior: prior as never }),
    ]),
    notificationContent: [
      [true, 'Jane', 'Hello   there', 'Subj', []],
      [false, '  ', null, null, ['a.pdf', '', 'b.png']],
      [false, 'Bob', '', '', []],
      [true, 'Al', 'x'.repeat(200), null, []],
    ].map(([isNew, customerName, body, subject, attachmentNames]) =>
      desk.deskNotificationContent({
        isNew: isNew as boolean,
        customerName: customerName as string,
        body: body as string | null,
        subject: subject as string | null,
        attachmentNames: attachmentNames as string[],
      }) as Json,
    ),
    normalizeEmailSubject: ['Re: Fwd: Hello ', 'FW:Hello', 'Hello Re: x', 'fwd:   ', ''].map((s) => [s, deskLib.normalizeEmailSubject(s)]),
    normalizeRfcMessageId: [' <a@b> ', '<>', 'plain', '<<x>>', ''].map((s) => [s, deskLib.normalizeRfcMessageId(s)]),
  };
}

// ---------------------------------------------------------------------------
// Mail rules (email-storage.store.test.ts's applyMailRules cases, and more)
// ---------------------------------------------------------------------------

async function rulesFixture(): Promise<Json> {
  const { applyMailRules } = await import(worker('email-storage'));
  const fakeDb = { update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) };
  const email = {
    emailId: 'e',
    messageId: '<r@x>',
    from: { email: 'Boss@Corp.test', name: 'Boss' },
    to: [{ email: 'me@acme.test' }, { email: 'team@acme.test' }],
    cc: [],
    subject: 'Invoice #42',
    textBody: 'please pay',
    htmlBody: '<p>please pay</p>',
    headers: {},
    receivedAt: new Date('2026-01-01T00:00:00.000Z'),
    hasAttachments: true,
    attachmentCount: 1,
  };
  const rule = (id: string, extra: Record<string, unknown>) => ({
    id,
    name: id,
    conditions: [{ field: 'subject', operator: 'contains', value: '' }],
    matchType: 'all',
    actions: [],
    isActive: true,
    stopProcessing: false,
    scope: 'incoming',
    folders: null,
    ...extra,
  });
  const base = { labels: ['INBOX'], isRead: false, isFlagged: false, isSpam: false, deleted: false };
  const cases: Array<[string, Array<Record<string, unknown>>, typeof base]> = [
    ['star', [rule('r1', { actions: [{ type: 'star' }] })], base],
    ['already starred', [rule('r1', { actions: [{ type: 'star' }] })], { ...base, labels: ['INBOX', 'STARRED'] }],
    ['spam', [rule('r1', { actions: [{ type: 'mark_as_spam' }] })], base],
    ['stop processing', [rule('r1', { stopProcessing: true, actions: [{ type: 'flag' }] }), rule('r2', { actions: [{ type: 'star' }] })], base],
    [
      'fixed snapshot',
      [
        rule('r1', { actions: [{ type: 'mark_as_spam' }] }),
        rule('r2', { conditions: [{ field: 'is_spam', operator: 'equals', value: 'true' }], actions: [{ type: 'flag' }] }),
      ],
      base,
    ],
    ['no match', [rule('r1', { conditions: [{ field: 'subject', operator: 'contains', value: 'nope' }], actions: [{ type: 'flag' }] })], base],
    [
      'operators',
      [
        rule('from', { conditions: [{ field: 'from', operator: 'ends_with', value: '@corp.TEST' }], actions: [{ type: 'add_label', labelId: 'Corp' }] }),
        rule('to', { conditions: [{ field: 'to', operator: 'equals', value: 'me@acme.test, team@acme.test' }], actions: [{ type: 'mark_as_read' }] }),
        rule('size', { conditions: [{ field: 'size', operator: 'less_than', value: ' 1 ' }], actions: [{ type: 'move_to_folder', labelId: 'Bills' }] }),
        rule('attach', { matchType: 'any', conditions: [{ field: 'has_attachment', operator: 'is_true', value: '' }, { field: 'cc', operator: 'contains', value: 'x' }], actions: [{ type: 'archive' }, { type: 'add_label' }] }),
        rule('priority', { conditions: [{ field: 'priority', operator: 'equals', value: ['NORMAL'] }], actions: [{ type: 'remove_label', labelId: 'Corp' }] }),
        rule('outgoing', { scope: 'outgoing', actions: [{ type: 'delete' }] }),
        rule('folders', { folders: ['SENT'], actions: [{ type: 'delete' }] }),
        rule('empty', { conditions: [], actions: [{ type: 'delete' }] }),
        rule('unknown', { conditions: [{ field: 'nope', operator: 'equals', value: 'x' }], actions: [{ type: 'delete' }] }),
        rule('bad op', { conditions: [{ field: 'body', operator: 'regex', value: 'x' }], actions: [{ type: 'delete' }] }),
        rule('greater', { conditions: [{ field: 'is_spam', operator: 'greater_than', value: '-1' }], actions: [{ type: 'unknown_action' }, { type: 'mark_as_unread' }] }),
      ],
      base,
    ],
    ['throws', [rule('r1', { actions: [{ type: 'flag' }] }), rule('r2', { conditions: [{ field: 'subject', operator: 'contains', value: 7 }], actions: [{ type: 'star' }] })], base],
  ];
  const out: Json[] = [];
  for (const [name, rules, state] of cases) {
    let result: Json;
    try {
      const outcome = await quietly(() => applyMailRules(fakeDb as never, rules as never, email as never, 'msg_1', state));
      result = { state: outcome.state as Json, markedSpam: outcome.markedSpam };
    } catch {
      result = 'throws';
    }
    out.push({ name, rules: rules as Json, state: state as Json, result });
  }
  return { email: { ...email, receivedAt: email.receivedAt.toISOString() } as Json, cases: out };
}

// ---------------------------------------------------------------------------
// Storage on pglite: storeEmail (Postgres mailbox store), rules + finalize
// ---------------------------------------------------------------------------

/** A bucket that records what was put. */
function recordingBucket() {
  const puts: Array<{ key: string; contentType: string | null; size: number }> = [];
  const bucket = {
    put: async (key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) => {
      const size = typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength;
      puts.push({ key, contentType: options?.httpMetadata?.contentType ?? null, size });
      return { key };
    },
    get: async () => null,
    head: async () => null,
    delete: async () => undefined,
  };
  return { bucket, puts };
}

const ID_PATTERNS: Array<[RegExp, string]> = [
  [/msg_[A-Za-z0-9_-]{21}/g, '<msg>'],
  [/attach_[0-9a-z]{9,}/g, '<attach>'],
  [/msub_[0-9a-z]{9,}/g, '<msub>'],
  [/dconv_[0-9a-z]{9,}/g, '<dconv>'],
  [/dmsg_[0-9a-z]{9,}/g, '<dmsg>'],
  [/dvis_[0-9a-z]{9,}/g, '<dvis>'],
];
const VOLATILE = new Set(['created_at', 'updated_at', 'received_date', 'last_seen_at', 'waiting_since', 'last_message_at', 'last_applied_at']);

/** Placeholders for generated ids and the times a write stamps. */
function normalise(value: Json, key = ''): Json {
  if (Array.isArray(value)) return value.map((v) => normalise(v));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) out[k] = normalise(value[k]!, k);
    return out;
  }
  if (typeof value === 'string') {
    if (VOLATILE.has(key)) return '<ts>';
    let text = value;
    for (const [pattern, placeholder] of ID_PATTERNS) text = text.replace(pattern, placeholder);
    return text;
  }
  return value;
}

const WS = 'ws_fx';
const ACCOUNT = 'mbx_fx';
const ACCOUNT_EMAIL = 'inbox@acme.test';
const PUBLIC_URL = 'https://files.acme.test';

function mailMessage(lines: string[]): RawCase {
  return { name: '', raw: utf8(crlf(lines)), envelopeTo: [ACCOUNT_EMAIL] };
}

const STORE_STEPS: Array<{ name: string; raw: RawCase; rules?: boolean }> = [
  {
    name: 'fresh',
    raw: mailMessage(['From: Alice <alice@partner.test>', `To: ${ACCOUNT_EMAIL}`, 'Subject: Project kickoff', 'Date: Mon, 26 Oct 2026 09:00:00 +0000', 'Message-ID: <s1@partner.test>', '', 'Kickoff on Monday.']),
  },
  {
    name: 'duplicate',
    raw: mailMessage(['From: Alice <alice@partner.test>', `To: ${ACCOUNT_EMAIL}`, 'Subject: Project kickoff', 'Date: Mon, 26 Oct 2026 09:00:00 +0000', 'Message-ID: <s1@partner.test>', '', 'Kickoff on Monday.']),
  },
  {
    name: 'reply-in-reply-to',
    raw: mailMessage(['From: Alice <alice@partner.test>', `To: ${ACCOUNT_EMAIL}`, 'Subject: Re: Project kickoff', 'Date: Mon, 26 Oct 2026 10:00:00 +0000', 'Message-ID: <s2@partner.test>', 'In-Reply-To: s1@partner.test', '', 'Agreed.']),
  },
  {
    name: 'reply-by-subject-participant',
    raw: mailMessage(['From: alice@partner.test', `To: ${ACCOUNT_EMAIL}`, 'Subject: RE: project KICKOFF', 'Date: Mon, 26 Oct 2026 11:00:00 +0000', 'Message-ID: <s3@partner.test>', '', 'One more thing.']),
  },
  {
    name: 'reply-by-subject-stranger',
    raw: mailMessage(['From: mallory@else.test', `To: ${ACCOUNT_EMAIL}`, 'Subject: Re: Project kickoff', 'Date: Mon, 26 Oct 2026 12:00:00 +0000', 'Message-ID: <s4@else.test>', '', 'Hi.']),
  },
  {
    name: 'spam',
    raw: mailMessage([
      'Authentication-Results: mx.test; spf=fail; dkim=fail; dmarc=fail',
      'From: "PayPal" <x@gmail.com>',
      `To: ${ACCOUNT_EMAIL}`,
      'Subject: Claim your prize',
      'Date: Mon, 26 Oct 2026 13:00:00 +0000',
      'Message-ID: <spam1@gmail.com>',
      'List-Unsubscribe: <https://spam.test/u>',
      '',
      'win',
    ]),
  },
  {
    name: 'promotion',
    raw: mailMessage([
      'Authentication-Results: mx.test; spf=pass; dkim=pass; dmarc=pass',
      'From: Shop <News@Shop.test>',
      `To: ${ACCOUNT_EMAIL}`,
      'Subject: Black Friday deals',
      'Date: Tue, 27 Oct 2026 08:00:00 +0000',
      'Message-ID: <p1@shop.test>',
      'List-Unsubscribe: <mailto:u@shop.test>, <https://shop.test/u>',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      'List-Id: <news.shop.test>',
      '',
      'Unsubscribe any time.',
    ]),
  },
  {
    name: 'promotion-again',
    raw: mailMessage([
      'Authentication-Results: mx.test; spf=pass; dkim=pass; dmarc=pass',
      'From: news@shop.test',
      `To: ${ACCOUNT_EMAIL}`,
      'Subject: Last chance: sale',
      'Date: Mon, 26 Oct 2026 08:00:00 +0000',
      'Message-ID: <p2@shop.test>',
      'List-Unsubscribe: <mailto:u2@shop.test>',
      '',
      'opt out',
    ]),
  },
  {
    name: 'attachments',
    raw: mailMessage([
      'Authentication-Results: mx.test; spf=pass; dkim=pass; dmarc=pass',
      'From: Billing <billing@vendor.test>',
      `To: ${ACCOUNT_EMAIL}`,
      'Cc: Ann <ann@acme.test>',
      'Subject: Invoice 42',
      'Date: Wed, 28 Oct 2026 10:00:00 +0000',
      'Message-ID: <inv42@vendor.test>',
      'Content-Type: multipart/mixed; boundary="o"',
      '',
      '--o',
      'Content-Type: multipart/related; boundary="r"',
      '',
      '--r',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p><img src="cid:logo@vendor"> Pay <b>now</b></p>',
      '--r',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo@vendor>',
      '',
      'iVBORw0KGgo=',
      '--r--',
      '--o',
      'Content-Type: application/pdf; name="factuur 42.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="factuur 42.pdf"',
      '',
      'JVBERi0xLjQK',
      '--o--',
    ]),
  },
  {
    name: 'rules',
    rules: true,
    raw: mailMessage([
      'Authentication-Results: mx.test; spf=pass; dkim=pass; dmarc=pass',
      'From: Bad Actor <bad@corp.test>',
      `To: ${ACCOUNT_EMAIL}`,
      'Subject: Quarterly report',
      'Date: Thu, 29 Oct 2026 10:00:00 +0000',
      'Message-ID: <rule1@corp.test>',
      '',
      'numbers',
    ]),
  },
];

const STORE_SEED = [
  `delete from mail_attachments where message_id in (select id from mail_messages where account_id = '${ACCOUNT}')`,
  `delete from mail_messages where account_id = '${ACCOUNT}'`,
  `delete from mail_subscriptions where account_id = '${ACCOUNT}'`,
  `delete from mail_rules where account_id = '${ACCOUNT}'`,
  `delete from mail_labels where account_id = '${ACCOUNT}'`,
  `delete from mail_accounts where id = '${ACCOUNT}'`,
  `insert into mail_accounts (id, name, email) values ('${ACCOUNT}', 'Inbox', '${ACCOUNT_EMAIL}')`,
  `insert into mail_rules (id, account_id, name, conditions, actions, priority, stop_processing)
     values ('rule_fx_spam', '${ACCOUNT}', 'Block bad', '[{"field":"from","operator":"contains","value":"bad@"}]', '[{"type":"mark_as_spam"},{"type":"flag"}]', 10, false),
            ('rule_fx_star', '${ACCOUNT}', 'Star corp', '[{"field":"from","operator":"ends_with","value":"@corp.test"}]', '[{"type":"star"}]', 5, true),
            ('rule_fx_never', '${ACCOUNT}', 'Never', '[{"field":"from","operator":"contains","value":"bad@"}]', '[{"type":"delete"}]', 1, false)`,
];

async function storeFixture(rows: (sql: string) => Promise<Json[]>, exec: (sql: string[]) => Promise<void>, db: never): Promise<Json> {
  const storage = await import(worker('email-storage'));
  const { adaptCloudflareEmail } = await import(worker('cf-email-adapter'));
  const { PostgresMailboxStore } = await import('../packages/domains/mail/src/store/postgres');
  await exec(STORE_SEED);
  const files = recordingBucket();
  const mail = recordingBucket();
  const env = { STORAGE: files.bucket, R2_PUBLIC_URL: PUBLIC_URL, MAIL_STORAGE: mail.bucket };
  const account = {
    accountId: ACCOUNT,
    accountEmail: ACCOUNT_EMAIL,
    isShared: true,
    tenantKind: 'workspace',
    workspaceId: WS,
    clerkOrgId: 'org_fx',
    personalAccountId: null,
    clerkUserId: null,
    members: [],
  };
  const mailbox = new PostgresMailboxStore(db, { workspaceId: WS, accountId: ACCOUNT });
  const steps: Json[] = [];
  for (const step of STORE_STEPS) {
    const message = await fakeMessage(step.raw.raw, ACCOUNT_EMAIL);
    const { email, attachments } = await adaptCloudflareEmail(message);
    const names = attachments.map((a: { fileName: string }) => a.fileName).filter(Boolean);
    const result = await quietly(() => storage.storeEmail(env as never, account as never, email, names, attachments, mailbox));
    let markedSpam: Json = null;
    if (result && step.rules) {
      const initial = { labels: [result.isSpam ? 'SPAM' : result.isPromotion ? 'PROMOTIONS' : 'INBOX'], isRead: false, isFlagged: false, isSpam: result.isSpam, deleted: false };
      const { schema } = await import('../packages/core/worker-kit/src/db');
      const { and, desc, eq, isNull } = await import('drizzle-orm');
      const ruleRows = await (db as { select: () => { from: (t: unknown) => { where: (c: unknown) => { orderBy: (o: unknown) => Promise<unknown[]> } } } })
        .select()
        .from(schema.mailRules)
        .where(and(eq(schema.mailRules.accountId, ACCOUNT), eq(schema.mailRules.isActive, true), isNull(schema.mailRules.deletedAt)))
        .orderBy(desc(schema.mailRules.priority));
      const outcome = await quietly(() => storage.applyMailRules(db, ruleRows as never, email, result.messageId, initial));
      if (outcome.state !== initial) await mailbox.apply(storage.finalizeOpFromStates(result.messageId, initial, outcome.state));
      markedSpam = outcome.markedSpam;
    }
    steps.push({
      name: step.name,
      raw: b64(step.raw.raw),
      stored: result ? (normalise({ threadId: result.threadId, isSpam: result.isSpam, isPromotion: Boolean(result.isPromotion) }) as Json) : null,
      markedSpam,
    });
  }
  const messageColumns = `id, message_id, thread_id, "from", "to", cc, bcc, reply_to, subject, preview, text_body, html_body, sent_date, received_date,
    is_read, is_starred, is_flagged, is_important, is_draft, is_spam, is_trash, has_attachments, attachment_count, in_reply_to, "references",
    is_reply, is_forwarded, labels, priority, spf_status, dkim_status, dmarc_status, source, size_bytes, raw_message, headers, deleted_at, created_at, updated_at`;
  return {
    workspaceId: WS,
    account: account as unknown as Json,
    publicUrl: PUBLIC_URL,
    seed: STORE_SEED,
    steps,
    messages: (await rows(`select to_jsonb(m) as row from (select ${messageColumns} from mail_messages where account_id = '${ACCOUNT}') m order by m.sent_date, m.message_id`)).map((r) => normalise(r)),
    attachments: (
      await rows(
        `select to_jsonb(a) as row from (select a.id, a.file_name, a.content_type, a.size, a.storage_path, a.download_url, a.is_inline, a.content_id, a.content_disposition, m.message_id as rfc
         from mail_attachments a join mail_messages m on m.id = a.message_id where m.account_id = '${ACCOUNT}') a order by a.rfc, a.file_name`,
      )
    ).map((r) => normalise(r)),
    subscriptions: (
      await rows(
        `select to_jsonb(s) as row from (select sender_email, sender_name, sender_domain, list_id, unsubscribe_url, unsubscribe_mailto, one_click, message_count, last_subject, first_received_at, last_received_at, status from mail_subscriptions where account_id = '${ACCOUNT}') s order by s.sender_email`,
      )
    ).map((r) => normalise(r)),
    rules: (await rows(`select to_jsonb(r) as row from (select id, applied_count from mail_rules where account_id = '${ACCOUNT}') r order by r.id`)).map((r) => normalise(r)),
    files: files.puts.map((p) => normalise(p as unknown as Json)),
    mail: mail.puts.map((p) => normalise(p as unknown as Json)),
  };
}

// ---------------------------------------------------------------------------
// WeldDesk email channel on pglite: ingestDeskEmail
// ---------------------------------------------------------------------------

const DESK_SEED = [
  `delete from desk_messages where conversation_id in (select id from desk_conversations where email like '%@cust.test')`,
  `delete from desk_conversations where email like '%@cust.test'`,
  `delete from desk_visitors where email like '%@cust.test'`,
];

async function deskFixture(rows: (sql: string) => Promise<Json[]>, exec: (sql: string[]) => Promise<void>, db: never): Promise<Json> {
  const { ingestDeskEmail } = await import('../packages/core/db/src/lib/desk');
  const { generateId } = await import('../packages/core/worker-kit/src/id');
  await exec(DESK_SEED);
  const inputs = [
    { fromName: 'Cara Customer', fromEmail: 'Cara@Cust.test', toAddress: 'support@acme.test', subject: 'Help needed', body: 'My   order\nis late', rfcMessageId: '<c1@cust.test>', toEmails: ['support@acme.test'], ccEmails: [], attachments: [{ name: 'a.pdf', url: 'https://f/a.pdf', contentType: 'application/pdf', filesize: 3 }] },
    { fromName: null, fromEmail: 'cara@cust.test', toAddress: 'support@acme.test', subject: 'Re: Help needed', body: 'Any news?', rfcMessageId: '<c2@cust.test>', inReplyTo: 'c1@cust.test', references: ['<c1@cust.test>'] },
    { fromName: 'Dan', fromEmail: 'dan@cust.test', toAddress: 'support@acme.test', subject: '', body: '', rfcMessageId: 'd1@cust.test' },
    { fromName: 'Dan D', fromEmail: 'dan@cust.test', toAddress: 'help@acme.test', subject: 'Fwd: Other topic', body: 'still open', rfcMessageId: '<d2@cust.test>', toEmails: ['help@acme.test', 'x@acme.test'], ccEmails: ['cc@acme.test'] },
  ];
  const results: Json[] = [];
  for (const input of inputs) {
    const out = await quietly(() => ingestDeskEmail(db, { generateId, ...input } as never));
    results.push(normalise({ created: out.created, conversationNumber: (out.conversation as { conversationNumber: number }).conversationNumber } as Json));
  }
  return {
    seed: DESK_SEED,
    inputs: inputs as unknown as Json,
    results,
    conversations: (
      await rows(
        `select to_jsonb(c) - 'id' - 'visitor_id' as row from desk_conversations c where c.email like '%@cust.test' order by c.conversation_number`,
      )
    ).map((r) => normalise(r)),
    messages: (
      await rows(
        `select to_jsonb(m) - 'id' - 'conversation_id' - 'author_id' || jsonb_build_object('conversation', c.conversation_number) as row
         from desk_messages m join desk_conversations c on c.id = m.conversation_id where c.email like '%@cust.test' order by c.conversation_number, m.created_at, m.body`,
      )
    ).map((r) => normalise(r)),
    visitors: (await rows(`select to_jsonb(v) - 'id' as row from desk_visitors v where v.email like '%@cust.test' order by v.email`)).map((r) => normalise(r)),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function writeFixtures(fixtures: Record<string, Json>): number {
  mkdirSync(outDir, { recursive: true });
  let stale = 0;
  for (const [name, value] of Object.entries(fixtures)) {
    const file = path.join(outDir, `${name}.json`);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const current = existsSync(file) ? readFileSync(file, 'utf8').replaceAll('\r\n', '\n') : null;
    if (!check) {
      writeFileSync(file, text);
      console.log(`wrote ${path.relative(repo, file)}`);
    } else if (current !== text) {
      console.error(`stale: ${path.relative(repo, file)}`);
      stale++;
    }
  }
  return stale;
}

async function main(): Promise<void> {
  const { createPgliteDb, pgliteClientOf } = await import('../packages/core/worker-kit/src/testing/pglite');
  const { db } = await createPgliteDb();
  const client = pgliteClientOf(db);
  if (!client) throw new Error('no pglite client');
  const exec = async (statements: string[]) => {
    for (const statement of statements) await client.exec(statement);
  };
  const rows = async (sql: string) => {
    const result = await client.query<{ row: Json }>(sql);
    return result.rows.map((r) => r.row);
  };
  const fixtures: Record<string, Json> = {
    parse: await parseFixture(),
    spam: await spamFixture(),
    promotion: await promotionFixture(),
    helpers: await helpersFixture(),
    rules: await rulesFixture(),
    store: await storeFixture(rows, exec, db as never),
    desk: await deskFixture(rows, exec, db as never),
  };
  if (writeFixtures(fixtures) > 0) {
    console.error('Run: pnpm rust:mail-inbound-fixtures');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
