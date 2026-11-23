/**
 * The shop's own strings: navigation, product, cart, checkout, account,
 * errors, B2B, legal and price notes, in every shop language (en, nl, de,
 * fr), all complete. Merchant content (section settings, products, pages) is
 * not translated here: it is in the shop's one language already.
 *
 *   const s = t('nl');
 *   format(s.cart.itemCount, { count: 3 });
 *
 * `{name}` in a string is a placeholder for `format()`; an object with `one`
 * and `other` is a plural for `plural()`.
 */

import type { StorefrontErrorCode } from '@weldsuite/commerce-sdk';
import { de } from './locales/de';
import { en } from './locales/en';
import { fr } from './locales/fr';
import { nl } from './locales/nl';
import { SHOP_LOCALES, type ShopLocale } from './types';

/** Every string of `T`, widened to `string`, so other languages must give the same keys. */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export type ShopStrings = Widen<typeof en>;

/** A plural: the `one` form for 1 (in these languages), `other` otherwise. */
export interface PluralForms {
  one: string;
  other: string;
}

const LOCALES: Record<ShopLocale, ShopStrings> = { en, nl, de, fr };

/** The strings of a shop language; English for anything else. */
export function t(locale: string | null | undefined): ShopStrings {
  return isShopLocale(locale) ? LOCALES[locale] : LOCALES.en;
}

export function isShopLocale(value: unknown): value is ShopLocale {
  return typeof value === 'string' && (SHOP_LOCALES as readonly string[]).includes(value);
}

/** The BCP 47 locale for numbers, prices and dates in a shop language. */
export function intlLocale(locale: ShopLocale): string {
  switch (locale) {
    case 'nl':
      return 'nl-NL';
    case 'de':
      return 'de-DE';
    case 'fr':
      return 'fr-FR';
    default:
      return 'en-IE';
  }
}

/** Fills `{name}` placeholders; unknown placeholders stay as they are. */
export function format(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

/** The plural form for `count`, with `{count}` filled in. */
export function plural(locale: ShopLocale, forms: PluralForms, count: number, values: Record<string, string | number> = {}): string {
  const rule = new Intl.PluralRules(intlLocale(locale)).select(count);
  return format(rule === 'one' ? forms.one : forms.other, { count, ...values });
}

/** Codes the renderer itself uses for failures that never reach the API. */
export type LocalErrorCode = keyof ShopStrings['errors']['local'];

/** A sentence for an API error code or one of the renderer's own; a generic one otherwise. */
export function errorMessage(strings: ShopStrings, code: string | null | undefined): string {
  if (!code) return strings.errors.generic;
  const codes = strings.errors.codes as Record<string, string>;
  const local = strings.errors.local as Record<string, string>;
  return codes[code] ?? local[code] ?? strings.errors.generic;
}

/** Why a discount code does not apply. */
export function discountReason(strings: ShopStrings, reason: string | null | undefined): string {
  const reasons = strings.errors.discount as Record<string, string>;
  return (reason && reasons[reason]) || strings.errors.discount.generic;
}

/** A word for an order, payment or approval status; the raw value made readable otherwise. */
export function statusLabel(strings: ShopStrings, kind: 'order' | 'payment' | 'approval' | 'fulfillment', status: string): string {
  const labels = strings.status[kind] as Record<string, string>;
  const known = labels[status];
  if (known) return known;
  const words = status.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every documented API error code, so the strings stay complete as the SDK grows. */
export type ApiErrorCode = StorefrontErrorCode;
