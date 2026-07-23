import type { Language } from './locales';

export type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * Locale-appropriate plural forms. `other` is mandatory; the rest are
 * filled in only when a target locale needs them (CLDR rules).
 *
 * Strings may contain `{count}` which is substituted with the numeric value.
 */
export type PluralForms = Partial<Record<PluralForm, string>> & { other: string };

/**
 * Pick the right plural form for `count` per the locale's CLDR plural rules
 * via `Intl.PluralRules`. Falls back to `other` when a specific form isn't
 * provided, so a Polish call site that only supplies one/other still renders.
 *
 * @example
 *   plural(1, { one: '{count} item', other: '{count} items' }, 'en') // "1 item"
 *   plural(5, { one: '{count} item', other: '{count} items' }, 'en') // "5 items"
 */
export function plural(count: number, forms: PluralForms, locale: Language): string {
  const category = new Intl.PluralRules(locale).select(count) as PluralForm;
  const template = forms[category] ?? forms.other;
  return template.replace(/\{count\}/g, String(count));
}
