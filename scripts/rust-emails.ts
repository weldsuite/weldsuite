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
 * - A list (the rows of a report) is rendered with one sample row per shape a
 *   row can take; each sample row becomes the body of a minijinja loop, so
 *   Rust passes the rows and writes no markup (`ListSpec`).
 * - The layout (`EmailLayout`: logo, inbox preview, footer) is exported once
 *   per locale and brand, and each variant only its content, so a variant is
 *   not stored three times. The plain text is stored per brand.
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
import { emailStrings, type EmailLocale } from '../packages/core/emails/src/i18n';
import { renderEmail, renderHtml, renderTemplate } from '../packages/core/emails/src/render';
import { formatReportNumber } from '../packages/core/emails/src/templates/desk/report';
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
  /** The lists the template renders, in the order it renders them: their rows become minijinja loops (see `ListSpec`). */
  lists?: (locale: EmailLocale, flags: Set<string>) => ListSpec[];
  props: (flags: Set<string>) => Record<string, unknown>;
}

/**
 * A list a template renders (the KPIs, agents and charts of a report). React
 * renders one sample row per shape a row can take; each row is cut out of the
 * render with the element around it and put back inside a loop, so Rust
 * passes the rows and re-implements no markup:
 *
 *   {% for row in kpis %}{% if row.shape == "value" %}…{% elif row.shape == "green" %}…{% endif %}{% endfor %}
 */
interface ListSpec {
  /** The list in the template's values (`kpis`; `chart.rows` inside a row of `charts`). */
  list: string;
  /** The loop variable. */
  item: string;
  /**
   * React leaves the section around the rows out when the list is empty, so
   * the section goes inside `{% if list %}`: the table around the rows, and in
   * the plain text the title line above them when `titled`.
   */
  section?: 'plain' | 'titled';
  /** One sample row per shape, in the order they are rendered. Rust sets `shape` on every row it passes. */
  shapes: ShapeSpec[];
}

interface ShapeSpec {
  name: string;
  /** A text only this sample row renders: how the row is found. */
  marker: string;
  /** What the row is: the innermost table around the marker (default), or its paragraph. */
  element?: 'table' | 'p';
  /** Rendered text → sentinel, inside the row. Each must occur exactly once there. */
  texts?: Record<string, string>;
  /** Lists inside the row. */
  lists?: ListSpec[];
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
  deskReportSpec(),
  ...calendarSpecs(),
];

/**
 * WeldDesk's scheduled report (`desk.report`): the overview (KPI rows, the
 * backlog, the top agents) or a saved report (a table per chart). The rows
 * are lists (`ListSpec`); the numbers in them are formatted by Rust
 * (`weldsuite_emails::desk`, as the template's `formatReportNumber`,
 * `formatReportDuration` and `changeOf` do), so each sample number's text
 * becomes a placeholder.
 */
function deskReportSpec(): Spec {
  // Sample figures no other part of the email contains.
  const KPI = { value: 900001, change: 900002, green: 900003, red: 900004 };
  const AGENT = { csat: 910001, plain: 910002, score: 12345.5 };
  const POINT = 920001.5;
  return {
    id: 'desk.report',
    flags: ['saved', 'backlog', 'by', 'csv'],
    fields: [
      'schedule_name',
      'report_title',
      'period_label',
      'backlog_open',
      'backlog_unassigned',
      'backlog_waiting',
      'url',
      'scheduled_by',
    ],
    lists: (locale) => {
      const t = emailStrings(locale).deskReport;
      const number = (value: number) => formatReportNumber(value, locale);
      return [
        {
          list: 'kpis',
          item: 'row',
          section: 'plain',
          shapes: [
            // The figure alone (no previous figure, or none at all).
            {
              name: 'value',
              marker: String(KPI.value),
              texts: { [t.kpi.created]: S('row.label'), [String(KPI.value)]: S('row.value') },
            },
            // A change that is neither good nor bad (new tickets).
            {
              name: 'change',
              marker: String(KPI.change),
              texts: { [t.kpi.created]: S('row.label'), [String(KPI.change)]: S('row.value'), '+100%': S('row.change') },
            },
            {
              name: 'green',
              marker: String(KPI.green),
              texts: { [t.kpi.resolved]: S('row.label'), [String(KPI.green)]: S('row.value'), '+100%': S('row.change') },
            },
            {
              name: 'red',
              marker: String(KPI.red),
              texts: { [t.kpi.resolved]: S('row.label'), [String(KPI.red)]: S('row.value'), '-50%': S('row.change') },
            },
          ],
        },
        {
          list: 'agents',
          item: 'agent',
          section: 'titled',
          shapes: [
            {
              name: 'csat',
              marker: String(AGENT.csat),
              texts: { [String(AGENT.csat)]: S('agent.resolved'), [number(AGENT.score)]: S('agent.csat') },
            },
            { name: 'plain', marker: String(AGENT.plain), texts: { [String(AGENT.plain)]: S('agent.resolved') } },
          ],
        },
        {
          list: 'charts',
          item: 'chart',
          shapes: [
            {
              name: 'rows',
              marker: S('chart.title'),
              lists: [
                {
                  list: 'chart.rows',
                  item: 'point',
                  shapes: [{ name: 'row', marker: number(POINT), texts: { [number(POINT)]: S('point.value') } }],
                },
              ],
            },
            // A chart without data is one muted line.
            { name: 'empty', marker: S('empty.title'), element: 'p', texts: { [S('empty.title')]: S('chart.title') } },
          ],
        },
      ];
    },
    props: (f) => ({
      scheduleName: S('schedule_name'),
      reportTitle: f.has('saved') ? S('report_title') : null,
      periodLabel: S('period_label'),
      kpis: [
        { key: 'created', value: KPI.value, previous: null },
        { key: 'created', value: KPI.change, previous: KPI.change / 2 },
        { key: 'resolved', value: KPI.green, previous: KPI.green / 2 },
        { key: 'resolved', value: KPI.red, previous: KPI.red * 2 },
      ],
      backlog: f.has('backlog')
        ? { open: S('backlog_open'), unassigned: S('backlog_unassigned'), waiting: S('backlog_waiting') }
        : null,
      agents: [
        { name: S('agent.name'), resolved: AGENT.csat, csat: AGENT.score },
        { name: S('agent.name'), resolved: AGENT.plain, csat: null },
      ],
      charts: [
        { title: S('chart.title'), rows: [{ label: S('point.label'), value: POINT }] },
        { title: S('empty.title'), rows: [] },
      ],
      url: S('url'),
      scheduledBy: f.has('by') ? S('scheduled_by') : null,
      csvAttached: f.has('csv'),
    }),
  };
}

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
  // A list row's field is `⟦row.label⟧`: the loop variable and its field.
  out = out.replace(/⟦([\w.]+)⟧/g, (_, name: string) => (mode === 'text' ? `{{ ${name}|collapse }}` : `{{ ${name} }}`));
  if (mode === 'html') out = out.replaceAll(ACCENT, '{{ accent }}');
  return out;
}

// ── lists ───────────────────────────────────────────────────────────────────

/** React's text escaping (`escapeTextForBrowser`), as a sample text sits in the HTML. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

/** Where `needle` is in `text`; it must be there exactly once. */
function indexOfOnce(text: string, needle: string, where: string): number {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`${where}: "${needle}" is not in the render`);
  if (text.indexOf(needle, at + needle.length) >= 0) throw new Error(`${where}: "${needle}" is in the render more than once`);
  return at;
}

/** Every `<tag>…</tag>` element of `html`, as `[start, end)`. */
function elementsOf(html: string, tag: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const open: number[] = [];
  for (const match of html.matchAll(new RegExp(`<${tag}[ >]|</${tag}>`, 'g'))) {
    if (match[0].startsWith('</')) {
      const start = open.pop();
      if (start === undefined) throw new Error(`a </${tag}> without its <${tag}>`);
      ranges.push([start, match.index + match[0].length]);
    } else open.push(match.index);
  }
  return ranges;
}

/** The smallest `tag` element for which `fits` holds. */
function innermost(html: string, tag: string, fits: (start: number, end: number) => boolean, where: string): [number, number] {
  const found = elementsOf(html, tag)
    .filter(([start, end]) => fits(start, end))
    .sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0];
  if (!found) throw new Error(`${where}: no <${tag}> around the row`);
  return found;
}

/** A row's sample texts as sentinels; each text is in the row exactly once. */
function sentinels(row: string, shape: ShapeSpec, escape: (text: string) => string, where: string): string {
  let out = row;
  for (const [text, sentinel] of Object.entries(shape.texts ?? {})) {
    const at = indexOfOnce(out, escape(text), `${where} ${shape.name}`);
    out = out.slice(0, at) + sentinel + out.slice(at + escape(text).length);
  }
  return out;
}

/** The loop over a list's rows, each shape behind its `shape`. */
function loopOf(list: ListSpec, rows: string[]): string {
  const body =
    rows.length === 1
      ? rows[0]!
      : `${rows.map((row, i) => `{% ${i === 0 ? 'if' : 'elif'} ${list.item}.shape == "${list.shapes[i]!.name}" %}${row}`).join('')}{% endif %}`;
  return `{% for ${list.item} in ${list.list} %}${body}{% endfor %}`;
}

/** The shapes' rows must follow each other in the render, in the order given. */
function adjacent(ranges: Array<[number, number]>, list: ListSpec, where: string): [number, number] {
  ranges.forEach(([start], i) => {
    if (i > 0 && start !== ranges[i - 1]![1]) throw new Error(`${where}: the rows of ${list.list} do not follow each other`);
  });
  return [ranges[0]![0], ranges.at(-1)![1]];
}

/** `html` with each list's sample rows replaced by a loop (see `ListSpec`). */
function loopHtml(html: string, lists: ListSpec[], where: string): string {
  let out = html;
  for (const list of lists) {
    const at = `${where} ${list.list}`;
    const ranges = list.shapes.map((shape) => {
      const marker = indexOfOnce(out, escapeHtml(shape.marker), at);
      return innermost(out, shape.element ?? 'table', (start, end) => start <= marker && marker < end, at);
    });
    let [start, end] = adjacent(ranges, list, at);
    const rows = list.shapes.map((shape, i) => {
      const row = out.slice(ranges[i]![0], ranges[i]![1]);
      return sentinels(shape.lists ? loopHtml(row, shape.lists, at) : row, shape, escapeHtml, at);
    });
    let loop = loopOf(list, rows);
    if (list.section) {
      const [from, to] = innermost(out, 'table', (s, e) => s < start && end < e, at);
      loop = `{% if ${list.list} %}${out.slice(from, start)}${loop}${out.slice(end, to)}{% endif %}`;
      [start, end] = [from, to];
    }
    out = out.slice(0, start) + loop + out.slice(end);
  }
  return out;
}

/** html-to-text writes every row as a line of its own, a blank line after it. */
const TEXT_ROW_END = '\n\n';

/** The line `marker` is on, with the blank line after it, as `[start, end)`. */
function textLine(text: string, marker: string, where: string): [number, number] {
  const at = indexOfOnce(text, marker, where);
  const before = text.lastIndexOf(TEXT_ROW_END, at);
  const after = text.indexOf(TEXT_ROW_END, at);
  if (after < 0) throw new Error(`${where}: a list is the last line of the plain text`);
  return [before < 0 ? 0 : before + TEXT_ROW_END.length, after + TEXT_ROW_END.length];
}

/** A row in the plain text: its own line, and the lines of the lists inside it. */
function textRow(text: string, shape: ShapeSpec, where: string): [number, number] {
  const [start, own] = textLine(text, shape.marker, where);
  const ends = (shape.lists ?? []).flatMap((list) => list.shapes.map((inner) => textRow(text, inner, where)[1]));
  return [start, Math.max(own, ...ends)];
}

/** The plain text with each list's sample rows replaced by a loop. */
function loopText(text: string, lists: ListSpec[], where: string): string {
  let out = text;
  // The last list first: a loop's closing tags sit at the start of the line
  // after it, so the lines above a list must still be as they were rendered.
  for (const list of [...lists].reverse()) {
    const at = `${where} ${list.list} (text)`;
    const ranges = list.shapes.map((shape) => textRow(out, shape, at));
    let [start, end] = adjacent(ranges, list, at);
    const rows = list.shapes.map((shape, i) => {
      const row = out.slice(ranges[i]![0], ranges[i]![1]);
      return sentinels(shape.lists ? loopText(row, shape.lists, at) : row, shape, (plain) => plain, at);
    });
    let loop = loopOf(list, rows);
    if (list.section) {
      // The title line above the rows belongs to the section.
      const from = list.section === 'titled' ? out.lastIndexOf(TEXT_ROW_END, start - TEXT_ROW_END.length - 1) + TEXT_ROW_END.length : start;
      loop = `{% if ${list.list} %}${out.slice(from, start)}${loop}{% endif %}`;
      start = from;
    }
    out = out.slice(0, start) + loop + out.slice(end);
  }
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

async function exportVariant(spec: Spec, locale: EmailLocale, flags: Set<string>): Promise<Variant> {
  const template = templates[spec.id] as unknown as EmailTemplate<Record<string, unknown>>;
  const props = spec.props(flags);
  const multiline = spec.multiline ?? [];
  const dates = Object.fromEntries(Object.entries(spec.dates ?? {}).filter(([flag]) => flags.has(flag)));
  const where = `${spec.name ?? spec.id} ${locale} [${variantKey(spec, flags)}]`;
  const texts = spec.texts?.(locale, flags) ?? {};
  const lists = spec.lists?.(locale, flags) ?? [];

  const text = {} as Record<BrandKey, string>;
  let canonical: { subject: string; preview: string; footer: string | null; content: string } | undefined;
  // The workspace brand first: its content carries the {{ accent }} placeholder.
  for (const brand of ['workspace', 'workspace_logo', 'weldsuite'] as const) {
    const rendered = await renderTemplate(template, props, { locale, brand: brandOf(brand) });
    guard(rendered.html, where);
    guard(rendered.text, where);
    const parts = await splitContent(rendered.html, locale, brand, `${where} ${brand}`);
    const content = placeholders(loopHtml(parts.content, lists, where), 'html', multiline, dates, locale, texts);
    const variant = {
      subject: placeholders(rendered.subject, 'plain', multiline, dates, locale, texts),
      preview: placeholders(parts.preview, 'plain', multiline, dates, locale, texts),
      footer: parts.footer === null ? null : placeholders(parts.footer, 'plain', multiline, dates, locale, texts),
      content,
    };
    // The WeldSuite brand has the theme accent where the others have the
    // placeholder; Rust passes the theme accent for it.
    const expected = canonical && brand === 'weldsuite'
      ? { ...canonical, content: canonical.content.replaceAll('{{ accent }}', theme.color.accent) }
      : canonical;
    if (!canonical) canonical = variant;
    else if (JSON.stringify(expected) !== JSON.stringify(variant)) {
      throw new Error(`${where}: the content depends on the brand (${brand}); it needs brand placeholders`);
    }
    text[brand] = placeholders(loopText(rendered.text, lists, where), 'text', multiline, dates, locale, texts);
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
      variants[locale][variantKey(spec, flags)] = await exportVariant(spec, locale, flags);
    }
  }
  // The lists and their rows' shapes (documentation for the Rust side, like `fields`).
  const shapesOf = (lists: ListSpec[]): Record<string, string[]> =>
    Object.assign(
      {},
      ...lists.map((list) => ({
        [list.list]: list.shapes.map((shape) => shape.name),
        ...shapesOf(list.shapes.flatMap((shape) => shape.lists ?? [])),
      })),
    ) as Record<string, string[]>;
  const lists = spec.lists ? { lists: shapesOf(spec.lists('en', new Set())) } : {};
  return stableJson({
    id: spec.name ?? spec.id,
    flags: spec.flags,
    fields: spec.fields,
    multiline: spec.multiline ?? [],
    ...lists,
    variants,
  });
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
