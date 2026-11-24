/**
 * The settings forms of the online store editor are generated from the
 * section catalog's `SettingDefinition`s: this file turns them into form
 * values and a Zod schema with the same limits the backend checks on save
 * (string lengths, number ranges, select options, safe URLs).
 */

import { z } from 'zod';
import { LIMITS, type SettingDefinition, type SettingValue, type SettingValues } from '@weldsuite/storefront-theme/catalog';
import { getTranslations } from '@/lib/i18n';
import { fill } from '@/app/weldcommerce/lib/text';

/** A path of this shop (`/products`), or a full `https://`, `mailto:` or `tel:` address. */
export function isSafeUrl(value: string): boolean {
  if (value.startsWith('/')) return !value.startsWith('//') && !/\s/.test(value);
  if (/^mailto:[^\s]+$/i.test(value) || /^tel:[+\d][\d\s().-]*$/i.test(value)) return true;
  return isHttpsUrl(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** An image: a full `https://` address or a path of this shop. */
export function isImageUrl(value: string): boolean {
  return (value.startsWith('/') && !value.startsWith('//') && !/\s/.test(value)) || isHttpsUrl(value);
}

const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

/** A YouTube or Vimeo address. */
export function isVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && VIDEO_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function maxLengthOf(definition: SettingDefinition): number {
  if (definition.maxLength) return definition.maxLength;
  return definition.type === 'richtext' ? LIMITS.richTextLength : LIMITS.textLength;
}

/** The schema of one setting's value. Empty is allowed for text-like settings, as the theme then draws nothing. */
export function settingSchema(definition: SettingDefinition): z.ZodTypeAny {
  const t = getTranslations('commerce').onlineStore.validation;
  const tooLong = fill(t.tooLong, { max: maxLengthOf(definition) });
  switch (definition.type) {
    case 'text':
    case 'textarea':
    case 'richtext':
    case 'form':
      return z.string().max(maxLengthOf(definition), tooLong);
    case 'url':
      return z
        .string()
        .max(maxLengthOf(definition), tooLong)
        .refine((value) => value === '' || isSafeUrl(value), t.url);
    case 'image':
      return z
        .string()
        .max(maxLengthOf(definition), tooLong)
        .refine((value) => value === '' || isImageUrl(value), t.image);
    case 'video':
      return z
        .string()
        .max(maxLengthOf(definition), tooLong)
        .refine((value) => value === '' || isVideoUrl(value), t.video);
    case 'color':
      // Empty only where the setting starts empty (the theme's own colours always have one).
      return z.string().refine((value) => (value === '' ? definition.default === '' : HEX_COLOR.test(value)), t.color);
    case 'select': {
      const values = (definition.options ?? []).map((option) => option.value);
      return z.string().refine((value) => values.includes(value), t.choose);
    }
    case 'checkbox':
      return z.boolean();
    case 'number': {
      const min = definition.min ?? Number.MIN_SAFE_INTEGER;
      const max = definition.max ?? Number.MAX_SAFE_INTEGER;
      const range = definition.min !== undefined && definition.max !== undefined ? fill(t.numberRange, { min, max }) : t.number;
      return z.number({ required_error: range, invalid_type_error: range }).min(min, range).max(max, range);
    }
    case 'categories':
    case 'products':
      return z.array(z.string());
    case 'category':
    case 'product':
    case 'menu':
    case 'page':
      return z.string();
    default:
      return z.unknown();
  }
}

export function settingsSchema(definitions: readonly SettingDefinition[]) {
  return z.object(Object.fromEntries(definitions.map((definition) => [definition.id, settingSchema(definition)])));
}

function fitsType(definition: SettingDefinition, value: SettingValue | undefined): boolean {
  switch (definition.type) {
    case 'checkbox':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'categories':
    case 'products':
      return Array.isArray(value);
    default:
      return typeof value === 'string';
  }
}

/** The form's values: each stored value of the right type, else the setting's default (a missing value is the default). */
export function formValues(definitions: readonly SettingDefinition[], settings: SettingValues): SettingValues {
  return Object.fromEntries(
    definitions.map((definition) => {
      const value = settings[definition.id];
      if (fitsType(definition, value)) return [definition.id, value as SettingValue];
      const fallback = definition.default;
      if (fitsType(definition, fallback)) return [definition.id, fallback];
      if (definition.type === 'checkbox') return [definition.id, false];
      if (definition.type === 'categories' || definition.type === 'products') return [definition.id, []];
      if (definition.type === 'number') return [definition.id, definition.min ?? 0];
      return [definition.id, ''];
    }),
  );
}
