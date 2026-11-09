/**
 * Export the system email templates (`@weldsuite/emails`) to minijinja
 * templates under rust/catalogs/emails/, so the Rust backend sends the same
 * mail as the workers (P3 of the editions plan: "React Email templates
 * pre-rendered at build time, filled in with minijinja").
 *
 *   pnpm rust:emails           write the files
 *   pnpm rust:emails --check   exit 1 when a file is missing or stale (CI)
 *
 * How a React template becomes a minijinja one:
 *
 * - Every string prop is rendered as a sentinel (`⟦title⟧`) that React writes
 *   through untouched; afterwards each sentinel becomes `{{ title }}`.
 * - Every branch a template takes on its props (a message or none, a link or
 *   an attachment) is a boolean flag, and each combination of flags is its
 *   own variant: no logic is re-implemented in Rust, only the choice of
 *   variant.
 * - Dates go through `formatDate`, which a sentinel cannot: a fixed sample
 *   date is rendered and its formatted text becomes the placeholder; Rust
 *   formats the real date the same way (`weldsuite-emails`).
 * - The layout (`EmailLayout`: logo, inbox preview, footer) is exported once
 *   per locale and brand, and each variant only its content, so a variant is
 *   not stored three times. The plain text is stored per brand.
 * - A list of rows (`<Details>`, `<List>`) becomes a minijinja loop over
 *   `rows`: rendered with one row and with two, the second row is the loop's
 *   body, and a render with several rows of every kind must equal the loop's
 *   output. A row's own branches (an optional part) are row variants, which
 *   Rust names per row (`row.v`), as it names a template's variant.
 *
 * Templates are listed in SPECS; one not listed has no Rust version yet.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';

import type { EmailBrand } from '../packages/core/emails/src/brand';
import { EmailLayout } from '../packages/core/emails/src/components/layout';
import type { EmailTemplate } from '../packages/core/emails/src/define';
import { formatDate, formatTime, formatWhen } from '../packages/core/emails/src/format';
import type { EmailLocale } from '../packages/core/emails/src/i18n';
import { renderEmail, renderHtml, renderTemplate } from '../packages/core/emails/src/render';
import { templates, type TemplateId } from '../packages/core/emails/src/templates/index';
import { theme } from '../packages/core/emails/src/theme';
import { emails as en } from '../packages/core/i18n/src/locales/en/emails';
import { emails as nl } from '../packages/core/i18n/src/locales/nl/emails';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'rust', 'catalogs', 'emails');

const LOCALES: EmailLocale[] = ['en', 'nl'];
const BRANDS = ['weldsuite', 'workspace', 'workspace_logo'] as const;
type BrandKey = (typeof BRANDS)[number];

/** Sentinels for values React or the brand helpers would otherwise change. */
const ACCENT = '#0a1b2c';
const LOGO = 'https://weld-logo.invalid/LOGO';
const SAMPLE_DATE = '2001-02-03T12:00:00.000Z';
/** The characters React Email's `<Preview>` pads the preview text with. */
const PREVIEW_FILLER_CHARS = '\u00A0\u200C\u200B\u200D\u200E\u200F\uFEFF';

/** The `<div>` of preview padding at the start of `html`, or '' (`renderWhiteSpace`). */
function leadingFiller(html: string): string {
  if (!html.startsWith('<div>')) return '';
  const end = html.indexOf('</div>');
  if (end < 0) return '';
  const inner = html.slice('<div>'.length, end);
  return [...inner].every((c) => PREVIEW_FILLER_CHARS.includes(c)) ? html.slice(0, end + '</div>'.length) : '';
}

const S = (name: string) => `⟦${name}⟧`;
/** The digest's "And {count} more." in the exported render: a number no real render shows. */
const DIGEST_MORE = 7_654_321;

function overallOf(flags: Set<string>): 'red' | 'amber' | 'green' {
  if (flags.has('red')) return 'red';
  return flags.has('amber') ? 'amber' : 'green';
}

function brandOf(key: BrandKey): EmailBrand {
  switch (key) {
    case 'weldsuite':
      return { kind: 'weldsuite', module: 'WeldSign' };
    case 'workspace':
      return { kind: 'workspace', name: S('__brand_name'), accentColor: ACCENT };
    case 'workspace_logo':
      return { kind: 'workspace', name: S('__brand_name'), accentColor: ACCENT, logoUrl: LOGO };
  }
}

/** A list of rows in a template, exported as a loop (see the top of this file). */
interface ListSpec {
  /** The template flag under which the list has rows; without it the list is empty. */
  flag: string;
  /** The branches one row takes, in a fixed order: a row's `v` is the set ones joined by `+`. */
  flags: string[];
  /** Placeholders a row uses (`{{ row.<field> }}`; documentation for the Rust side). */
  fields: string[];
  /** One row's props for its flags, its sentinels made with `R(i, field)`. */
  row: (flags: Set<string>, i: number) => unknown;
  /** Rendered text that depends on how many rows there are (n) → its replacement (a sentinel). */
  counted?: (locale: EmailLocale, n: number) => Record<string, string>;
}

/** A row's sentinel: row `i`'s `field`. */
const R = (i: number, field: string) => `⟦r${i}_${field}⟧`;

interface Spec {
  id: TemplateId;
  /**
   * The exported name, when one template is exported as several (one per
   * `kind`, so the kinds' flags don't multiply): `templates/<name>.json`.
   */
  name?: string;
  /** The branches, in a fixed order: a variant key is the set ones joined by `+`. */
  flags: string[];
  /** Placeholders the variants use (documentation for the Rust side). */
  fields: string[];
  /** Fields rendered with `<MultilineText>`. */
  multiline?: string[];
  /** A flag that adds a date: the placeholder its formatted text becomes. */
  dates?: Record<string, string>;
  /**
   * Text the render contains that Rust writes itself (a formatted time range,
   * a URL around a sentinel): rendered text → what replaces it, usually a
   * sentinel (`⟦when⟧`), before the sentinels become placeholders.
   */
  texts?: (locale: EmailLocale, flags: Set<string>) => Record<string, string>;
  /** A list of rows (`rows`), when the template has one. */
  list?: ListSpec;
  /** Flag combinations that cannot happen (a list's rows without the list): not exported. */
  exclude?: (flags: Set<string>) => boolean;
  /** The props for the flags; `rows` are the list's rows (empty without one). */
  props: (flags: Set<string>, rows: unknown[]) => Record<string, unknown>;
}

const SPECS: Spec[] = [
  {
    id: 'sign.request',
    flags: ['message', 'expires', 'reminder'],
    fields: ['sender_name', 'title', 'message', 'url', 'expires_date'],
    multiline: ['message'],
    dates: { expires: 'expires_date' },
    props: (f) => ({
      senderName: S('sender_name'),
      title: S('title'),
      message: f.has('message') ? S('message') : null,
      url: S('url'),
      expiresAt: f.has('expires') ? SAMPLE_DATE : null,
      timeZone: 'UTC',
      reminder: f.has('reminder'),
    }),
  },
  {
    id: 'sign.code',
    flags: [],
    fields: ['title', 'code', 'minutes'],
    props: () => ({ title: S('title'), code: S('code'), expiresInMinutes: S('minutes') }),
  },
  {
    // WeldForms: the code a respondent enters on a verified-email form.
    id: 'forms.code',
    flags: [],
    fields: ['title', 'code', 'minutes'],
    props: () => ({ title: S('title'), code: S('code'), expiresInMinutes: S('minutes') }),
  },
  // WeldForms: an invitation (or a reminder of one) with the person's own link.
  // A sender's own subject is used by Rust as is (`subject` is never rendered).
  {
    id: 'forms.invite',
    flags: ['message', 'closes', 'reminder'],
    fields: ['sender_name', 'title', 'message', 'url', 'closes_date'],
    multiline: ['message'],
    dates: { closes: 'closes_date' },
    props: (f) => ({
      senderName: S('sender_name'),
      title: S('title'),
      subject: null,
      message: f.has('message') ? S('message') : null,
      url: S('url'),
      closesAt: f.has('closes') ? SAMPLE_DATE : null,
      timeZone: 'UTC',
      reminder: f.has('reminder'),
    }),
  },
  // WeldForms: a copy of the respondent's answers (a <Details> row per answer).
  {
    id: 'forms.receipt',
    flags: ['rows', 'number'],
    fields: ['title', 'number'],
    list: { flag: 'rows', flags: [], fields: ['question', 'answer'], row: (_f, i) => ({ question: R(i, 'question'), answer: R(i, 'answer') }) },
    props: (f, rows) => ({ title: S('title'), number: f.has('number') ? S('number') : null, answers: rows }),
  },
  // WeldForms: a new response to a subscriber: the answers, or only the link
  // when the form has sensitive fields (`link_only`, `answers: null`).
  {
    id: 'forms.response',
    flags: ['respondent', 'link_only', 'rows'],
    fields: ['title', 'respondent', 'url'],
    exclude: (f) => f.has('link_only') && f.has('rows'),
    list: { flag: 'rows', flags: [], fields: ['question', 'answer'], row: (_f, i) => ({ question: R(i, 'question'), answer: R(i, 'answer') }) },
    props: (f, rows) => ({
      title: S('title'),
      number: null,
      respondent: f.has('respondent') ? S('respondent') : null,
      answers: f.has('link_only') ? null : rows,
      url: S('url'),
    }),
  },
  // WeldForms: the daily digest. `count` reads as its sentinel and counts as
  // DIGEST_MORE more than the rows shown (`more`: "And {count} more."
  // renders) or as the rows shown; the list's title carries how many are
  // listed (`listed`).
  {
    id: 'forms.digest',
    flags: ['rows', 'more'],
    fields: ['title', 'workspace_name', 'count', 'more', 'listed', 'url'],
    texts: () => ({ [String(DIGEST_MORE)]: S('more') }),
    list: {
      flag: 'rows',
      flags: ['respondent', 'summary', 'number'],
      fields: ['respondent', 'summary', 'number'],
      row: (f, i) => ({
        number: f.has('number') ? R(i, 'number') : null,
        respondent: f.has('respondent') ? R(i, 'respondent') : null,
        summary: f.has('summary') ? R(i, 'summary') : null,
      }),
      counted: (locale, n) => {
        const latest = (locale === 'nl' ? nl : en).forms.digest.latest;
        return { [`${latest} · ${n}`]: `${latest} · ${S('listed')}` };
      },
    },
    props: (f, rows) => ({
      title: S('title'),
      workspaceName: S('workspace_name'),
      // Text where it is filled in, a number where `count - responses.length` is worked out.
      count: { toString: () => S('count'), valueOf: () => (f.has('more') ? DIGEST_MORE + rows.length : rows.length) },
      responses: rows,
      url: S('url'),
    }),
  },
  // WeldForms: the workspace used 80 % (`full` unset) or all of its monthly responses.
  {
    id: 'forms.quota',
    flags: ['full'],
    fields: ['workspace_name', 'percent', 'used', 'limit', 'resets_date', 'url'],
    texts: (locale) => ({ [formatDate(SAMPLE_DATE, locale, 'UTC')]: S('resets_date') }),
    props: (f) => ({
      workspaceName: S('workspace_name'),
      percent: f.has('full') ? 100 : S('percent'),
      used: S('used'),
      limit: S('limit'),
      resetsAt: SAMPLE_DATE,
      url: S('url'),
    }),
  },
  {
    id: 'sign.completed',
    flags: ['attached', 'url', 'for_sender'],
    fields: ['title', 'signers', 'url'],
    props: (f) => ({
      title: S('title'),
      signers: [S('signers')],
      attached: f.has('attached'),
      url: f.has('url') ? S('url') : null,
      forSender: f.has('for_sender'),
    }),
  },
  {
    id: 'sign.declined',
    flags: [],
    fields: ['title', 'declined_by', 'reason', 'url'],
    multiline: ['reason'],
    props: () => ({ title: S('title'), declinedBy: S('declined_by'), reason: S('reason'), url: S('url') }),
  },
  {
    id: 'sign.voided',
    flags: [],
    fields: ['sender_name', 'title', 'reason'],
    multiline: ['reason'],
    props: () => ({ senderName: S('sender_name'), title: S('title'), reason: S('reason') }),
  },
  {
    id: 'sign.expired',
    flags: ['unsigned'],
    fields: ['title', 'unsigned', 'url'],
    props: (f) => ({ title: S('title'), unsigned: f.has('unsigned') ? [S('unsigned')] : [], url: S('url') }),
  },
  // The order portal's sign-in mail (WeldCommerce): a link and a code, or a code only.
  {
    id: 'portal.sign-in',
    flags: ['url'],
    fields: ['portal_name', 'code', 'url', 'minutes'],
    props: (f) => ({
      portalName: S('portal_name'),
      code: S('code'),
      url: f.has('url') ? S('url') : null,
      expiresInMinutes: S('minutes'),
    }),
  },
  {
    id: 'hr.payslip-ready',
    flags: ['name', 'url'],
    fields: ['recipient_name', 'employer_name', 'pay_date', 'url'],
    // The pay date is formatted by Rust (`formatDate(${payDate}T12:00:00Z, locale, UTC)`).
    texts: (locale) => ({ [formatDate(SAMPLE_DATE, locale, 'UTC')]: S('pay_date') }),
    props: (f) => ({
      recipientName: f.has('name') ? S('recipient_name') : null,
      employerName: S('employer_name'),
      payDate: SAMPLE_DATE.slice(0, 10),
      url: f.has('url') ? S('url') : null,
    }),
  },
  {
    id: 'hr.bank-changed',
    flags: ['name', 'by_employee'],
    fields: ['recipient_name', 'employer_name', 'when'],
    // "<date>, <time zone>" of the change, formatted by Rust in UTC (the worker passes no zone).
    texts: (locale) => ({
      [`${formatDate(SAMPLE_DATE, locale, 'UTC')}, ${formatTime(SAMPLE_DATE, locale, 'UTC', true)}`]: S('when'),
    }),
    props: (f) => ({
      recipientName: f.has('name') ? S('recipient_name') : null,
      employerName: S('employer_name'),
      byEmployee: f.has('by_employee'),
      changedAt: SAMPLE_DATE,
    }),
  },
  // WeldFlow's published status report: the overall colour is two flags (none:
  // green, `amber`, `red`; `amber+red` is exported but never chosen, it renders
  // as red). The period label is written by Rust (`period_label`).
  {
    id: 'flow.status-report',
    flags: ['name', 'by', 'amber', 'red'],
    fields: ['recipient_name', 'project_name', 'period_label', 'summary', 'published_by', 'url'],
    multiline: ['summary'],
    props: (f) => ({
      recipientName: f.has('name') ? S('recipient_name') : null,
      projectName: S('project_name'),
      periodLabel: S('period_label'),
      overall: overallOf(f),
      summary: S('summary'),
      publishedBy: f.has('by') ? S('published_by') : null,
      url: S('url'),
    }),
  },
  // WeldFlow's invitation of a CRM contact to the client project portal.
  {
    id: 'flow.portal-invitation',
    flags: ['name', 'by'],
    fields: ['contact_name', 'project_name', 'invited_by', 'workspace_name', 'url'],
    props: (f) => ({
      contactName: f.has('name') ? S('contact_name') : null,
      projectName: S('project_name'),
      invitedBy: f.has('by') ? S('invited_by') : null,
      workspaceName: S('workspace_name'),
      url: S('url'),
    }),
  },
  // WeldReach's access decisions, sent by `weldsuite admin access` (ADR
  // SEC-014). The three limits go through `toLocaleString`, which leaves a
  // sentinel string as it is; Rust groups the digits the same way (en-US
  // `1,000`, nl-NL `1.000`).
  {
    id: 'reach.access-approved',
    flags: ['name', 'limits'],
    fields: ['recipient_name', 'workspace_name', 'url', 'domains', 'mailboxes', 'sends'],
    props: (f) => ({
      recipientName: f.has('name') ? S('recipient_name') : null,
      workspaceName: S('workspace_name'),
      url: S('url'),
      limits: f.has('limits')
        ? { maxDomains: S('domains'), maxMailboxes: S('mailboxes'), maxDailySends: S('sends') }
        : null,
    }),
  },
  {
    id: 'reach.access-rejected',
    flags: ['name', 'url'],
    fields: ['recipient_name', 'workspace_name', 'reason', 'url'],
    multiline: ['reason'],
    props: (f) => ({
      recipientName: f.has('name') ? S('recipient_name') : null,
      workspaceName: S('workspace_name'),
      reason: S('reason'),
      url: f.has('url') ? S('url') : null,
    }),
  },
  // WeldMeet's invitation: the join link, and the meeting's time when it is
  // scheduled (`formatWhen`, written by Rust, becomes `{{ when }}`).
  {
    id: 'meet.invitation',
    flags: ['when', 'description'],
    fields: ['organizer_name', 'title', 'when', 'description', 'join_url'],
    multiline: ['description'],
    texts: (locale) => ({
      [formatWhen({ start: SAMPLE_DATE, end: '2001-02-03T13:00:00.000Z', locale, timeZone: 'UTC' })]: S('when'),
    }),
    props: (f) => ({
      organizerName: S('organizer_name'),
      title: S('title'),
      description: f.has('description') ? S('description') : null,
      startTime: f.has('when') ? SAMPLE_DATE : null,
      endTime: f.has('when') ? '2001-02-03T13:00:00.000Z' : null,
      timezone: 'UTC',
      joinUrl: S('join_url'),
    }),
  },
  ...calendarSpecs(),
];

/**
 * WeldCalendar's attendee mail (`calendar.event`), one export per kind. The
 * time lines are `formatWhen`'s, which Rust formats (`weldsuite_emails::format_when`):
 * the samples' text becomes `{{ when }}` / `{{ was }}`. A WeldMeet join link
 * is rendered under a WeldMeet host, so the button reads "Join WeldMeet
 * meeting", and the host is cut off again around the sentinel.
 */
function calendarSpecs(): Spec[] {
  const WHEN = { start: SAMPLE_DATE, end: '2001-02-03T13:00:00.000Z' };
  const WAS = { start: '2001-02-04T15:00:00.000Z', end: '2001-02-04T16:00:00.000Z' };
  const WELDMEET = 'https://meet.weldsuite.org/x/';
  const open = ['where', 'description', 'meeting', 'weldmeet', 'event_url'];
  const kinds: Array<{ kind: string; flags: string[] }> = [
    { kind: 'invite', flags: open },
    { kind: 'update', flags: open },
    { kind: 'reschedule', flags: ['was', ...open] },
    { kind: 'restored', flags: open },
    { kind: 'cancel', flags: ['where'] },
    { kind: 'removed', flags: ['where'] },
  ];
  const meetingUrl = (f: Set<string>): string | null => {
    if (!f.has('meeting')) return null;
    const prefix = f.has('weldmeet') ? WELDMEET : '';
    return `${prefix}${S('meeting_url')}`;
  };
  return kinds.map(({ kind, flags }) => ({
    id: 'calendar.event',
    name: `calendar.event.${kind}`,
    flags,
    fields: ['organizer_name', 'title', 'when', 'was', 'where', 'description', 'meeting_url', 'event_url'],
    multiline: ['description'],
    texts: (locale, f) => ({
      [formatWhen({ ...WHEN, locale, timeZone: 'UTC' })]: S('when'),
      ...(f.has('was') ? { [formatWhen({ ...WAS, locale, timeZone: 'UTC' })]: S('was') } : {}),
      [`${WELDMEET}${S('meeting_url')}`]: S('meeting_url'),
    }),
    props: (f) => ({
      kind,
      organizerName: S('organizer_name'),
      title: S('title'),
      description: f.has('description') ? S('description') : null,
      startTime: WHEN.start,
      endTime: WHEN.end,
      oldStartTime: f.has('was') ? WAS.start : null,
      oldEndTime: f.has('was') ? WAS.end : null,
      location: f.has('where') ? S('where') : null,
      timezone: 'UTC',
      allDay: false,
      meetingUrl: meetingUrl(f),
      eventUrl: f.has('event_url') ? S('event_url') : null,
    }),
  }));
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** JSON with object keys sorted, so a reordering in TypeScript is not a diff. */
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, val]) => [k, sort(val)]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** React's text escaping, undone. */
function unescapeHtml(html: string): string {
  return html
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');
}

/** Every subset of `flags`, as sets, in a stable order. */
function combinations(flags: string[]): Set<string>[] {
  const out: Set<string>[] = [];
  for (let mask = 0; mask < 1 << flags.length; mask++) {
    out.push(new Set(flags.filter((_, i) => mask & (1 << i))));
  }
  return out;
}

function variantKey(spec: Spec, flags: Set<string>): string {
  return spec.flags.filter((f) => flags.has(f)).join('+');
}

function guard(text: string, where: string): void {
  if (/\{\{|\{%|\{#/.test(text)) throw new Error(`${where}: rendered output already contains minijinja syntax`);
}

function assertClean(text: string, where: string): void {
  const at = text.indexOf('⟦');
  if (at >= 0) throw new Error(`${where}: a sentinel was left: ${text.slice(at, at + 40)}`);
  if (text.includes(ACCENT) || text.includes(LOGO)) throw new Error(`${where}: a brand sentinel was left`);
}

type Mode = 'html' | 'text' | 'plain';

/**
 * Sentinels → placeholders. `html`: autoescaped, multiline fields through the
 * `multiline` filter (React's `<span>line<br/></span>` per line); `text`:
 * whitespace collapsed as html-to-text does (`collapse`, `text_lines`);
 * `plain`: as is (subject, preview, footer).
 */
function placeholders(
  text: string,
  mode: Mode,
  multiline: string[],
  dates: Record<string, string>,
  locale: EmailLocale,
  texts: Record<string, string> = {},
): string {
  let out = text;
  for (const [literal, replacement] of Object.entries(texts)) out = out.replaceAll(literal, replacement);
  for (const [, name] of Object.entries(dates)) {
    out = out.replaceAll(formatDate(SAMPLE_DATE, locale, 'UTC'), `{{ ${name} }}`);
  }
  for (const name of multiline) {
    if (mode === 'html') out = out.replaceAll(`<span>${S(name)}</span>`, `{{ ${name}|multiline }}`);
    else if (mode === 'text') out = out.replaceAll(S(name), `{{ ${name}|text_lines }}`);
  }
  out = out.replace(/⟦(\w+)⟧/g, (_, name: string) => (mode === 'text' ? `{{ ${name}|collapse }}` : `{{ ${name} }}`));
  if (mode === 'html') out = out.replaceAll(ACCENT, '{{ accent }}');
  return out;
}

// ── layouts ─────────────────────────────────────────────────────────────────

async function layoutHtml(locale: EmailLocale, brand: BrandKey, preview: string, footer: string | undefined): Promise<string> {
  return renderHtml(
    createElement(EmailLayout, { brand: brandOf(brand), locale, preview, footer, children: S('__content') }),
  );
}

/** The layout as a minijinja template: preview, footer, content and brand as placeholders. */
async function layoutTemplate(locale: EmailLocale, brand: BrandKey, withFooter: boolean): Promise<string> {
  const html = await layoutHtml(locale, brand, S('__preview'), withFooter ? S('__footer') : undefined);
  guard(html, `layout ${locale}/${brand}`);
  const marker = S('__preview');
  const filler = leadingFiller(html.slice(html.indexOf(marker) + marker.length));
  const preview = marker + filler;
  const out = html
    .replace(preview, '{{ __preview|preview_block }}')
    .replace(S('__footer'), '{{ __footer }}')
    .replace(S('__content'), '{{ __content }}')
    .replaceAll(S('__brand_name'), '{{ __brand_name }}')
    .replaceAll(LOGO, '{{ __logo_url }}');
  assertClean(out, `layout ${locale}/${brand}`);
  return out;
}

// ── variants ────────────────────────────────────────────────────────────────

interface Variant {
  subject: string;
  preview: string;
  footer: string | null;
  html: string;
  text: Record<BrandKey, string>;
}

/** Split a full render into layout and content, given the layout around it. */
async function splitContent(full: string, locale: EmailLocale, brand: BrandKey, where: string) {
  const opening = 'data-skip-in-text="true">';
  const start = full.indexOf(opening);
  if (start < 0) throw new Error(`${where}: no inbox preview found`);
  const afterOpening = full.slice(start + opening.length);
  const preview = unescapeHtml(afterOpening.slice(0, afterOpening.indexOf('<')));

  const [a, b] = (await layoutHtml(locale, brand, preview, undefined)).split(S('__content'));
  if (a !== undefined && b !== undefined && full.startsWith(a) && full.endsWith(b)) {
    return { preview, footer: null, content: full.slice(a.length, full.length - b.length) };
  }
  const [fa, fb] = (await layoutHtml(locale, brand, preview, S('__footer'))).split(S('__content'));
  const [b1, b2] = (fb ?? '').split(S('__footer'));
  if (fa === undefined || b1 === undefined || b2 === undefined || !full.startsWith(fa) || !full.endsWith(b2)) {
    throw new Error(`${where}: the render does not fit the layout`);
  }
  const rest = full.slice(fa.length, full.length - b2.length);
  const at = rest.lastIndexOf(b1);
  const footerHtml = rest.slice(at + b1.length);
  if (footerHtml.includes('<')) throw new Error(`${where}: the footer is not plain text`);
  return { preview, footer: unescapeHtml(footerHtml), content: rest.slice(0, at) };
}

/** One render, split into its parts, still in sentinel form. */
interface Sentinels {
  subject: string;
  preview: string;
  footer: string | null;
  content: string;
  text: string;
}

async function sentinels(
  spec: Spec,
  locale: EmailLocale,
  flags: Set<string>,
  brand: BrandKey,
  rows: unknown[],
  where: string,
): Promise<Sentinels> {
  const template = templates[spec.id] as unknown as EmailTemplate<Record<string, unknown>>;
  const rendered = await renderTemplate(template, spec.props(flags, rows), { locale, brand: brandOf(brand) });
  guard(rendered.html, where);
  guard(rendered.text, where);
  const parts = await splitContent(rendered.html, locale, brand, `${where} ${brand}`);
  const out: Sentinels = { subject: rendered.subject, preview: parts.preview, footer: parts.footer, content: parts.content, text: rendered.text };
  for (const [literal, replacement] of Object.entries(spec.list?.counted?.(locale, rows.length) ?? {})) {
    out.subject = out.subject.replaceAll(literal, replacement);
    out.preview = out.preview.replaceAll(literal, replacement);
    out.footer = out.footer === null ? null : out.footer.replaceAll(literal, replacement);
    out.content = out.content.replaceAll(literal, replacement);
    out.text = out.text.replaceAll(literal, replacement);
  }
  return out;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** The last character of `text`, or its last sentinel whole. */
function lastUnit(text: string): string {
  return text.endsWith('⟧') && text.includes('⟦') ? text.slice(text.lastIndexOf('⟦')) : text.slice(-1);
}

/**
 * The part a list's second row added: `one` is prefix + row 0 + suffix,
 * `two` prefix + row 0 + row 1 + suffix. The row comes back with generic
 * sentinels (`⟦r_field⟧`). Where the row could start a little earlier or
 * later (it ends as the text before it ends, or starts as the text after it
 * starts) the earliest start is taken, so every row variant splits the same.
 */
function splitRows(one: string, two: string, where: string): { prefix: string; row: string; suffix: string } {
  const at = commonPrefixLength(one, two);
  let suffix = one.slice(at);
  const rest = two.slice(at);
  if (!rest.endsWith(suffix)) throw new Error(`${where}: a second row does not insert into the render`);
  const second = rest.slice(0, rest.length - suffix.length);
  const first = second.replaceAll('⟦r1_', '⟦r0_');
  const head = one.slice(0, at);
  if (second === '' || !head.endsWith(first)) throw new Error(`${where}: the rows do not repeat`);
  let prefix = head.slice(0, head.length - first.length);
  let row = second.replaceAll('⟦r1_', '⟦r_');
  for (;;) {
    const unit = lastUnit(prefix);
    if (unit === '' || unit !== lastUnit(row) || row.length <= unit.length) break;
    prefix = prefix.slice(0, -unit.length);
    row = unit + row.slice(0, -unit.length);
    suffix = unit + suffix;
  }
  // Then forward to the next tag or line, so a row reads as whole tags.
  while (row.length > 1 && row[0] !== '<' && row[0] !== '\n' && row[0] !== '⟦' && row[0] === suffix[0]) {
    prefix += row[0];
    row = row.slice(1) + row[0];
    suffix = suffix.slice(1);
  }
  return { prefix, row, suffix };
}

/** Row `i` of a row in generic form. */
const rowAt = (row: string, i: number) => row.replaceAll('⟦r_', `⟦r${i}_`);

/** The list as a loop: one body, or a branch per row variant (`row.v`). */
function loop(bodies: Map<string, string>, mode: Mode, convert: (text: string) => string): string {
  const fill = (row: string) =>
    convert(row.replace(/⟦r_(\w+)⟧/g, (_, name: string) => (mode === 'text' ? `{{ row.${name}|collapse }}` : `{{ row.${name} }}`)));
  const entries = [...bodies];
  const body =
    entries.length === 1
      ? fill(entries[0]![1])
      : `${entries.map(([key, row], i) => `{% ${i === 0 ? 'if' : 'elif'} row.v == "${key}" %}${fill(row)}`).join('')}{% endif %}`;
  return `{% for row in rows %}${body}{% endfor %}`;
}

/**
 * A variant with a list, for one brand: the loop derived from renders with
 * one and two rows of each row variant, then checked against a render with
 * rows of every variant in turn.
 */
async function listSentinels(spec: Spec, list: ListSpec, locale: EmailLocale, flags: Set<string>, brand: BrandKey, where: string) {
  const kinds = combinations(list.flags);
  const key = (rowFlags: Set<string>) => list.flags.filter((f) => rowFlags.has(f)).join('+');
  type Outside = Pick<Sentinels, 'subject' | 'preview' | 'footer'>;
  type Frame = { content: [string, string]; text: [string, string] };
  let shared: Outside | undefined;
  let frame: Frame | undefined;
  const content = new Map<string, string>();
  const text = new Map<string, string>();
  for (const kind of kinds) {
    const k = key(kind);
    const one = await sentinels(spec, locale, flags, brand, [list.row(kind, 0)], `${where} row [${k}]`);
    const two = await sentinels(spec, locale, flags, brand, [list.row(kind, 0), list.row(kind, 1)], `${where} rows [${k}]`);
    const c = splitRows(one.content, two.content, `${where} [${k}] html`);
    const t = splitRows(one.text, two.text, `${where} [${k}] text`);
    const outside: Outside = { subject: one.subject, preview: one.preview, footer: one.footer };
    const twoOutside: Outside = { subject: two.subject, preview: two.preview, footer: two.footer };
    if (JSON.stringify(outside) !== JSON.stringify(twoOutside)) throw new Error(`${where}: subject, preview or footer depends on the rows`);
    const around: Frame = { content: [c.prefix, c.suffix], text: [t.prefix, t.suffix] };
    shared ??= outside;
    frame ??= around;
    if (JSON.stringify(shared) !== JSON.stringify(outside) || JSON.stringify(frame) !== JSON.stringify(around)) {
      throw new Error(`${where}: the row variant [${k}] changes what is around the list`);
    }
    content.set(k, c.row);
    text.set(k, t.row);
  }
  // Rows of every variant in turn (each twice, at most nine): the loop must give the same render.
  const order = [...kinds, ...kinds].slice(0, 9);
  const mixed = await sentinels(spec, locale, flags, brand, order.map((kind, i) => list.row(kind, i)), `${where} mixed rows`);
  const expect = (parts: [string, string], rows: Map<string, string>) =>
    parts[0] + order.map((kind, i) => rowAt(rows.get(key(kind))!, i)).join('') + parts[1];
  if (expect(frame!.content, content) !== mixed.content) throw new Error(`${where}: the html loop does not reproduce a render with mixed rows`);
  if (expect(frame!.text, text) !== mixed.text) throw new Error(`${where}: the text loop does not reproduce a render with mixed rows`);
  return { shared: shared!, frame: frame!, content, text };
}

async function exportVariant(spec: Spec, locale: EmailLocale, flags: Set<string>): Promise<Variant> {
  const multiline = spec.multiline ?? [];
  const dates = Object.fromEntries(Object.entries(spec.dates ?? {}).filter(([flag]) => flags.has(flag)));
  const where = `${spec.name ?? spec.id} ${locale} [${variantKey(spec, flags)}]`;
  const texts = spec.texts?.(locale, flags) ?? {};
  const ph = (value: string, mode: Mode) => placeholders(value, mode, multiline, dates, locale, texts);
  const list = spec.list && flags.has(spec.list.flag) ? spec.list : undefined;

  const text = {} as Record<BrandKey, string>;
  let canonical: { subject: string; preview: string; footer: string | null; content: string } | undefined;
  // The workspace brand first: its content carries the {{ accent }} placeholder.
  for (const brand of ['workspace', 'workspace_logo', 'weldsuite'] as const) {
    let variant: { subject: string; preview: string; footer: string | null; content: string };
    if (list) {
      const derived = await listSentinels(spec, list, locale, flags, brand, where);
      variant = {
        subject: ph(derived.shared.subject, 'plain'),
        preview: ph(derived.shared.preview, 'plain'),
        footer: derived.shared.footer === null ? null : ph(derived.shared.footer, 'plain'),
        content:
          ph(derived.frame.content[0], 'html') + loop(derived.content, 'html', (v) => ph(v, 'html')) + ph(derived.frame.content[1], 'html'),
      };
      text[brand] = ph(derived.frame.text[0], 'text') + loop(derived.text, 'text', (v) => ph(v, 'text')) + ph(derived.frame.text[1], 'text');
    } else {
      const parts = await sentinels(spec, locale, flags, brand, [], where);
      variant = {
        subject: ph(parts.subject, 'plain'),
        preview: ph(parts.preview, 'plain'),
        footer: parts.footer === null ? null : ph(parts.footer, 'plain'),
        content: ph(parts.content, 'html'),
      };
      text[brand] = ph(parts.text, 'text');
    }
    // The WeldSuite brand has the theme accent where the others have the
    // placeholder; Rust passes the theme accent for it.
    const expected =
      canonical && brand === 'weldsuite' ? { ...canonical, content: canonical.content.replaceAll('{{ accent }}', theme.color.accent) } : canonical;
    if (!canonical) canonical = variant;
    else if (JSON.stringify(expected) !== JSON.stringify(variant)) {
      throw new Error(`${where}: the content depends on the brand (${brand}); it needs brand placeholders`);
    }
    assertClean(text[brand], `${where} ${brand} text`);
  }
  const { subject, preview, footer, content } = canonical!;
  for (const [part, value] of Object.entries({ subject, preview, footer: footer ?? '', content })) {
    assertClean(value, `${where} ${part}`);
  }
  return { subject, preview, footer, html: content, text };
}

// ── main ────────────────────────────────────────────────────────────────────

/** One layout per locale and brand, with and without a footer. */
async function exportLayouts(): Promise<string> {
  const layouts: Record<string, Record<string, { plain: string; footer: string }>> = {};
  for (const locale of LOCALES) {
    layouts[locale] = {};
    for (const brand of BRANDS) {
      layouts[locale][brand] = {
        plain: await layoutTemplate(locale, brand, false),
        footer: await layoutTemplate(locale, brand, true),
      };
    }
  }
  return stableJson({ theme: { accent: theme.color.accent }, layouts });
}

/** Every variant of a template, per locale. */
async function exportTemplate(spec: Spec): Promise<string> {
  const variants: Record<string, Record<string, Variant>> = {};
  for (const locale of LOCALES) {
    variants[locale] = {};
    for (const flags of combinations(spec.flags)) {
      if (spec.exclude?.(flags)) continue;
      variants[locale][variantKey(spec, flags)] = await exportVariant(spec, locale, flags);
    }
  }
  const list = spec.list ? { flag: spec.list.flag, flags: spec.list.flags, fields: spec.list.fields } : undefined;
  return stableJson({ id: spec.name ?? spec.id, flags: spec.flags, fields: spec.fields, multiline: spec.multiline ?? [], list, variants });
}

/**
 * What the TypeScript renderer writes for each template's preview props:
 * weldsuite-emails' tests must render the same.
 */
async function renderCases(): Promise<string> {
  const cases: unknown[] = [];
  const done = new Set<string>();
  for (const spec of SPECS) {
    // A template exported as several specs has its previews once.
    if (done.has(spec.id)) continue;
    done.add(spec.id);
    const template = templates[spec.id] as unknown as EmailTemplate<Record<string, unknown>>;
    for (const [name, preview] of Object.entries(template.previews)) {
      for (const locale of LOCALES) {
        const brand = preview.brand ?? template.defaultBrand;
        // A brand without the "Sent via WeldSuite" line has no exported layout
        // (weldsuite-emails' "Not supported yet"): no case for it.
        if ((brand as { poweredBy?: boolean }).poweredBy === false) continue;
        const expected = await renderEmail(spec.id, preview.props as never, { locale, brand });
        cases.push({ template: spec.id, preview: name, locale, brand, props: preview.props, expected });
      }
    }
  }
  return stableJson(cases);
}

/** Files that differ from what is on disk; written unless `check`. */
function sync(files: Map<string, string>, check: boolean): string[] {
  const stale: string[] = [];
  for (const [name, content] of files) {
    const file = path.join(outDir, name);
    const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === content) continue;
    stale.push(name);
    if (!check) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  // A template exported before and dropped from SPECS since.
  const templateDir = path.join(outDir, 'templates');
  if (existsSync(templateDir)) {
    for (const name of readdirSync(templateDir)) {
      if (!files.has(`templates/${name}`)) stale.push(`templates/${name} (no longer exported; delete it)`);
    }
  }
  return stale;
}

async function main() {
  const check = process.argv.includes('--check');
  const files = new Map<string, string>();
  files.set('layouts.json', await exportLayouts());
  for (const spec of SPECS) files.set(`templates/${spec.name ?? spec.id}.json`, await exportTemplate(spec));
  files.set('strings.en.json', stableJson(en));
  files.set('strings.nl.json', stableJson(nl));
  const caseFile = path.join(repo, 'rust', 'crates', 'emails', 'tests', 'fixtures', 'render-cases.json');
  files.set(path.relative(outDir, caseFile).split(path.sep).join('/'), await renderCases());

  const stale = sync(files, check);
  if (!check) {
    console.log(`Wrote ${stale.length} changed file(s) of ${files.size} under rust/catalogs/emails.`);
    return;
  }
  if (stale.length) {
    console.error(`rust/catalogs/emails is stale; run \`pnpm rust:emails\`:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log('rust/catalogs/emails is current.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
