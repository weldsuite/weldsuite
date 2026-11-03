/**
 * Generates rust/crates/books-domain/data/invoice.json: the data the printed
 * invoice of @weldsuite/books-domain uses, which the Rust port reads instead
 * of re-typing it — each jurisdiction's invoice requirements (labels per
 * language, required fields, required footer), the compliance notices, and
 * the metrics of the standard PDF fonts (`@pdf-lib/standard-fonts`: WinAnsi
 * glyph widths and kerning pairs) the invoice-template layout measures with.
 *
 *   pnpm --filter @weldsuite/books-domain exec tsx ../../../rust/crates/books-domain/tools/invoice-export.mts
 *
 * Commit the output; regenerate when that data changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts';
import { getAdapter } from '../../../../packages/domains/books/src/jurisdictions/registry';
import * as nl from '../../../../packages/domains/books/src/jurisdictions/nl/invoice-format';
import * as india from '../../../../packages/domains/books/src/jurisdictions/in/invoice-format';
import * as br from '../../../../packages/domains/books/src/jurisdictions/br/invoice-format';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The requirements without the number formatter (a function). */
function requirementsOf(code: string, locale: string) {
  const { formatInvoiceNumber: _format, ...rest } = getAdapter(code).getInvoiceRequirements(locale);
  return rest;
}

// The label language each adapter picks from the locale (see the adapters' getXInvoiceRequirements).
const requirements = {
  NL: { nl: requirementsOf('NL', 'nl-NL'), en: requirementsOf('NL', 'en-US') },
  BR: { pt: requirementsOf('BR', 'pt-BR'), en: requirementsOf('BR', 'en-US') },
  IN: { any: requirementsOf('IN', 'en-IN') },
  US: { any: requirementsOf('US', 'en-US') },
};

const notices = {
  NL_NOTICE_REVERSE_CHARGE_DOMESTIC: nl.NL_NOTICE_REVERSE_CHARGE_DOMESTIC,
  NL_NOTICE_REVERSE_CHARGE_EU: nl.NL_NOTICE_REVERSE_CHARGE_EU,
  NL_NOTICE_ICL: nl.NL_NOTICE_ICL,
  NL_NOTICE_KOR: nl.NL_NOTICE_KOR,
  IN_NOTICE_REVERSE_CHARGE: india.IN_NOTICE_REVERSE_CHARGE,
  IN_NOTICE_EXPORT: india.IN_NOTICE_EXPORT,
  BR_NOTICE_SIMPLES: br.BR_NOTICE_SIMPLES,
  BR_NOTICE_MEI: br.BR_NOTICE_MEI,
  BR_NOTICE_EXPORT: br.BR_NOTICE_EXPORT,
  BR_NOTICE_NOT_FISCAL: br.BR_NOTICE_NOT_FISCAL,
};

// Glyph names of the WinAnsi encoding, by Unicode code point.
const winAnsi = Encodings.WinAnsi;
const glyphOf: Record<number, string> = {};
for (let cp = 0; cp <= 0xffff; cp++) {
  if (winAnsi.canEncodeUnicodeCodePoint(cp)) glyphOf[cp] = winAnsi.encodeUnicodeCodePoint(cp).name;
}
const glyphNames = [...new Set(Object.values(glyphOf))].sort();
const glyphIndex = new Map(glyphNames.map((name, i) => [name, i]));

const FONT_NAMES = [
  FontNames.Helvetica,
  FontNames.HelveticaBold,
  FontNames.HelveticaOblique,
  FontNames.HelveticaBoldOblique,
  FontNames.TimesRoman,
  FontNames.TimesRomanBold,
  FontNames.TimesRomanItalic,
  FontNames.TimesRomanBoldItalic,
  FontNames.Courier,
  FontNames.CourierBold,
  FontNames.CourierOblique,
  FontNames.CourierBoldOblique,
];

const fonts = Object.fromEntries(
  FONT_NAMES.map((name) => {
    const font = Font.load(name);
    // getWidthOfGlyph(name) || 0, per glyph index.
    const widths = glyphNames.map((glyph) => font.getWidthOfGlyph(glyph) || 0);
    const kerning: Array<[number, number, number]> = [];
    for (const a of glyphNames) {
      for (const b of glyphNames) {
        const kern = font.getXAxisKerningForPair(a, b) || 0;
        if (kern) kerning.push([glyphIndex.get(a)!, glyphIndex.get(b)!, kern]);
      }
    }
    return [
      name,
      {
        ascent: ((font.Ascender || font.FontBBox[3]) as number) / 1000,
        widths,
        question: font.getWidthOfGlyph('question') || 0,
        kerning,
      },
    ];
  }),
);

// Intl: how Node's ICU (the conformance reference) formats money, numbers and long dates per
// locale. A template is the parts of `formatToParts`, the digits collapsed into "#".
const LOCALES = [
  'en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA', 'en-IE', 'en-NZ', 'en-ZA', 'en',
  'nl-NL', 'nl-BE', 'nl', 'pt-BR', 'pt-PT', 'pt', 'de-DE', 'de-AT', 'de-CH', 'de',
  'fr-FR', 'fr-BE', 'fr-CA', 'fr-CH', 'fr', 'es-ES', 'es-MX', 'es', 'it-IT', 'it',
  'pl-PL', 'pl', 'sv-SE', 'sv', 'da-DK', 'da', 'nb-NO', 'nb', 'fi-FI', 'fi', 'hi-IN',
];
const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'INR', 'BRL', 'CHF', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN',
  'CNY', 'MXN', 'ZAR', 'NZD', 'SGD', 'HKD', 'AED', 'CZK', 'HUF', 'RON', 'TRY', 'ILS', 'KRW',
];
const NUMERIC = new Set(['integer', 'group', 'decimal', 'fraction']);

function template(parts: Intl.NumberFormatPart[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (NUMERIC.has(part.type)) {
      if (out[out.length - 1] !== '#') out.push('#');
    } else {
      out.push(part.value);
    }
  }
  return out;
}

function numberShape(locale: string) {
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  const parts = fmt.formatToParts(1234567890.5);
  const integers = parts.filter((p) => p.type === 'integer').map((p) => p.value.length);
  const group = parts.find((p) => p.type === 'group')?.value ?? '';
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  const primary = integers[integers.length - 1] ?? 3;
  const secondary = integers.length > 2 ? integers[integers.length - 2] : primary;
  // minimumGroupingDigits: is 1234 grouped?
  const minGrouping = fmt.formatToParts(1234).some((p) => p.type === 'group') ? 1 : 2;
  return {
    group,
    decimal,
    primary,
    secondary,
    minGrouping,
    negative: template(fmt.formatToParts(-1234.5)),
    positive: template(fmt.formatToParts(1234.5)),
  };
}

function currencyShape(locale: string, currency: string) {
  const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const shape = numberShape(locale);
  const parts = fmt.formatToParts(1234567.5);
  const group = parts.find((p) => p.type === 'group')?.value ?? shape.group;
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? shape.decimal;
  return {
    positive: template(parts),
    negative: template(fmt.formatToParts(-1234567.5)),
    digits: fmt.resolvedOptions().maximumFractionDigits,
    // Currency formats may use their own separators (de-CH, fr-CH).
    group,
    decimal,
    minGrouping: fmt.formatToParts(1234).some((p) => p.type === 'group') ? 1 : 2,
  };
}

function dateShape(locale: string) {
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const sample = fmt.formatToParts(new Date(Date.UTC(2026, 2, 5)));
  const pattern = sample.map((p) => (p.type === 'day' || p.type === 'month' || p.type === 'year' ? `{${p.type}}` : p.value));
  const months = Array.from({ length: 12 }, (_, m) =>
    fmt.formatToParts(new Date(Date.UTC(2026, m, 5))).find((p) => p.type === 'month')?.value ?? '',
  );
  return { pattern, months };
}

const intl = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    {
      number: numberShape(locale),
      currency: Object.fromEntries(CURRENCIES.map((c) => [c, currencyShape(locale, c)])),
      date: dateShape(locale),
    },
  ]),
);

// Test vectors for the Rust port (data/intl-cases.json is only read by its tests).
const values = [0, -0, 0.005, 1.005, 2.675, -0.004, 7.5, 21, 99.995, 1234.5, -1234.567, 1234567.891, 123456789.125, 0.12345];
const cases = LOCALES.flatMap((locale) => [
  ...['EUR', 'USD', 'INR', 'JPY', 'CHF'].flatMap((currency) =>
    values.map((value) => ({ locale, currency, value, out: new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value) })),
  ),
  ...values.map((value) => ({ locale, value, out: new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value) })),
  ...['2026-01-31T00:00:00.000Z', '2026-12-01T00:00:00.000Z'].map((date) => ({
    locale,
    date,
    out: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date)),
  })),
]);
writeFileSync(path.join(here, '..', 'data', 'intl-cases.json'), `${JSON.stringify(cases)}\n`);

const out = {
  $comment: 'Generated by tools/invoice-export.mts; do not edit.',
  requirements,
  notices,
  intl,
  glyphs: { names: glyphNames, byCodePoint: Object.fromEntries(Object.entries(glyphOf).map(([cp, g]) => [cp, glyphIndex.get(g)])) },
  fonts,
};

const target = path.join(here, '..', 'data', 'invoice.json');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(out)}\n`);
console.log(`wrote ${target}`);
