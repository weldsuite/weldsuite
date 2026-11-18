/**
 * Form plumbing shared by the WeldCommerce dialogs.
 *
 * - `register` options that turn an empty input into "not given": an empty
 *   text input is `""` and an empty `valueAsNumber` input is `NaN`, both of
 *   which an optional Zod field rejects. `handleSubmit` then never calls
 *   `onSubmit`, and the dialog looks like it refuses to save.
 * - A Zod error map with translated messages. The dialogs validate with the
 *   API's shared schemas, whose messages are English; `zodResolver(schema,
 *   commerceSchemaOptions())` swaps in the UI language without touching them.
 *   A message written into a schema check wins over the map, so the dialogs
 *   translate those fields themselves (the company website, for one).
 */

import { z } from 'zod';
import { getTranslations } from '@/lib/i18n';

/** `register` options for an optional text input: blank is "not given". */
export const optionalText = {
  setValueAs: (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
};

/** `register` options for an optional number input: blank is "not given", not NaN. */
export const optionalNumber = {
  setValueAs: (v: unknown) => (v === '' || v == null ? undefined : Number(v)),
};

/** `register` options for a currency code input: trimmed, upper case, blank is "not given". */
export const currencyInput = {
  setValueAs: (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() || undefined : v),
};

/** An ISO 4217 code as the forms take it (the inputs upper-case what is typed). */
export const CURRENCY_CODE = /^[A-Z]{3}$/;

/** The customer portal shows its logo as an image: an http(s) address, or nothing. */
export function isPortalLogoUrl(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** The customer portal themes itself with these as CSS colors: `#rgb` or `#rrggbb`, or nothing. */
export function isPortalColor(value: string): boolean {
  return value === '' || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

function isEmptyInput(data: unknown): boolean {
  return data === undefined || data === null || data === '' || (typeof data === 'number' && Number.isNaN(data));
}

function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

function validationMessages() {
  return getTranslations('commerce').module.validation;
}

type Messages = ReturnType<typeof validationMessages>;

function tooSmallMessage(issue: z.ZodTooSmallIssue, v: Messages): string {
  const min = Number(issue.minimum);
  if (issue.type === 'string') {
    if (issue.exact) return fill(v.exactLength, { length: min });
    return min <= 1 ? v.required : fill(v.tooShort, { min });
  }
  if (issue.type === 'number') return fill(v.tooSmallNumber, { min });
  return v.invalid;
}

function tooBigMessage(issue: z.ZodTooBigIssue, v: Messages): string {
  const max = Number(issue.maximum);
  if (issue.type === 'string') {
    return issue.exact ? fill(v.exactLength, { length: max }) : fill(v.tooLong, { max });
  }
  if (issue.type === 'number') return fill(v.tooBigNumber, { max });
  return v.invalid;
}

function invalidStringMessage(issue: z.ZodInvalidStringIssue, v: Messages): string {
  if (issue.validation === 'email') return v.invalidEmail;
  if (issue.validation === 'url') return v.invalidUrl;
  return v.invalid;
}

export function createCommerceErrorMap(): z.ZodErrorMap {
  const v = validationMessages();
  return (issue, ctx) => {
    switch (issue.code) {
      case z.ZodIssueCode.invalid_type:
        if (isEmptyInput(ctx.data)) return { message: v.required };
        // `z.number().int()` reports a fraction as an invalid type, expected "integer".
        if (issue.expected === 'integer') return { message: v.wholeNumber };
        return { message: issue.expected === 'number' ? v.invalidNumber : v.invalid };
      case z.ZodIssueCode.too_small:
        return { message: tooSmallMessage(issue, v) };
      case z.ZodIssueCode.too_big:
        return { message: tooBigMessage(issue, v) };
      case z.ZodIssueCode.invalid_string:
        return { message: invalidStringMessage(issue, v) };
      case z.ZodIssueCode.not_finite:
        return { message: v.invalidNumber };
      default:
        return { message: ctx.defaultError };
    }
  };
}

/**
 * The second argument of `zodResolver(schema, ...)`. The resolver types it as
 * Zod's full ParseParams, so `path` and `async` are present although only the
 * error map matters.
 */
export function commerceSchemaOptions() {
  return { errorMap: createCommerceErrorMap(), path: [] as Array<string | number>, async: false };
}
