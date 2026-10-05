import { Fragment, createElement, type ReactNode } from 'react';
import { emails as en } from '@weldsuite/i18n/locales/en/emails';
import { emails as nl } from '@weldsuite/i18n/locales/nl/emails';

export type EmailLocale = 'en' | 'nl';
export type EmailStrings = typeof en;

export const EMAIL_LOCALES: readonly EmailLocale[] = ['en', 'nl'];

const STRINGS: Record<EmailLocale, EmailStrings> = { en, nl };

/** BCP 47 tags used for date formatting. */
const INTL_LOCALE: Record<EmailLocale, string> = { en: 'en-US', nl: 'nl-NL' };

export function emailStrings(locale: EmailLocale): EmailStrings {
  return STRINGS[locale];
}

export function intlLocale(locale: EmailLocale): string {
  return INTL_LOCALE[locale];
}

/**
 * The locale to write to a recipient in, from the most specific preference that
 * is set: the recipient's own language, then the workspace's, then English.
 * Unsupported languages (es, fr, …) fall through to the next candidate.
 */
export function resolveEmailLocale(
  ...candidates: Array<string | null | undefined>
): EmailLocale {
  for (const candidate of candidates) {
    const base = candidate?.trim().toLowerCase().split(/[-_]/)[0];
    if (base && (EMAIL_LOCALES as readonly string[]).includes(base)) return base as EmailLocale;
  }
  return 'en';
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Fill `{name}` placeholders with plain values. Unknown placeholders stay as-is. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * Fill `{name}` placeholders with React nodes, e.g. a bold organizer name inside
 * a translated sentence. Text around the placeholders stays plain text, so it is
 * escaped like any other React child.
 */
export function rich(template: string, values: Record<string, ReactNode>): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1];
    if (key === undefined || !(key in values)) continue;
    if (match.index > last) parts.push(template.slice(last, match.index));
    parts.push(createElement(Fragment, { key: `${key}-${match.index}` }, values[key]));
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push(template.slice(last));
  return parts;
}
