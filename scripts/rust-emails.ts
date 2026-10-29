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
import { formatDate } from '../packages/core/emails/src/format';
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
  /** The branches, in a fixed order: a variant key is the set ones joined by `+`. */
  flags: string[];
  /** Placeholders the variants use (documentation for the Rust side). */
  fields: string[];
  /** Fields rendered with `<MultilineText>`. */
  multiline?: string[];
  /** A flag that adds a date: the placeholder its formatted text becomes. */
  dates?: Record<string, string>;
  props: (flags: Set<string>) => Record<string, unknown>;
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
];

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
function placeholders(text: string, mode: Mode, multiline: string[], dates: Record<string, string>, locale: EmailLocale): string {
  let out = text;
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

async function exportVariant(spec: Spec, locale: EmailLocale, flags: Set<string>): Promise<Variant> {
  const template = templates[spec.id] as unknown as EmailTemplate<Record<string, unknown>>;
  const props = spec.props(flags);
  const multiline = spec.multiline ?? [];
  const dates = Object.fromEntries(Object.entries(spec.dates ?? {}).filter(([flag]) => flags.has(flag)));
  const where = `${spec.id} ${locale} [${variantKey(spec, flags)}]`;

  const text = {} as Record<BrandKey, string>;
  let canonical: { subject: string; preview: string; footer: string | null; content: string } | undefined;
  // The workspace brand first: its content carries the {{ accent }} placeholder.
  for (const brand of ['workspace', 'workspace_logo', 'weldsuite'] as const) {
    const rendered = await renderTemplate(template, props, { locale, brand: brandOf(brand) });
    guard(rendered.html, where);
    guard(rendered.text, where);
    const parts = await splitContent(rendered.html, locale, brand, `${where} ${brand}`);
    const content = placeholders(parts.content, 'html', multiline, dates, locale);
    const variant = {
      subject: placeholders(rendered.subject, 'plain', multiline, dates, locale),
      preview: placeholders(parts.preview, 'plain', multiline, dates, locale),
      footer: parts.footer === null ? null : placeholders(parts.footer, 'plain', multiline, dates, locale),
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
    text[brand] = placeholders(rendered.text, 'text', multiline, dates, locale);
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
  return stableJson({ id: spec.id, flags: spec.flags, fields: spec.fields, multiline: spec.multiline ?? [], variants });
}

/**
 * What the TypeScript renderer writes for each template's preview props:
 * weldsuite-emails' tests must render the same.
 */
async function renderCases(): Promise<string> {
  const cases: unknown[] = [];
  for (const spec of SPECS) {
    const template = templates[spec.id] as unknown as EmailTemplate<Record<string, unknown>>;
    for (const [name, preview] of Object.entries(template.previews)) {
      for (const locale of LOCALES) {
        const brand = preview.brand ?? template.defaultBrand;
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
  for (const spec of SPECS) files.set(`templates/${spec.id}.json`, await exportTemplate(spec));
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
