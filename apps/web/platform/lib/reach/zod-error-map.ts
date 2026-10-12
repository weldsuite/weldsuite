/**
 * Translated validation messages for the WeldReach forms.
 *
 * The forms validate with the contract's own Zod schemas
 * (`@weldsuite/app-api-client/schemas/reach`), whose default messages are
 * English. `zodResolver(schema, { errorMap })` swaps in the UI language
 * without changing the schema; a message written into a schema check
 * (for example the mailbox address pattern) wins over the map, so forms
 * that use one translate it themselves.
 */

import { z } from 'zod';

type Translate = (path: string, params?: Record<string, unknown>) => string;

function isEmptyInput(data: unknown): boolean {
  return data === undefined || data === null || data === '' || (typeof data === 'number' && Number.isNaN(data));
}

export function createReachErrorMap(t: Translate): z.ZodErrorMap {
  return (issue, ctx) => {
    switch (issue.code) {
      case z.ZodIssueCode.invalid_type:
        return { message: isEmptyInput(ctx.data) ? t('reach.validation.required') : t('reach.validation.invalidType') };
      case z.ZodIssueCode.too_small: {
        const min = Number(issue.minimum);
        if (issue.type === 'string') {
          return { message: min <= 1 ? t('reach.validation.required') : t('reach.validation.tooShort', { min }) };
        }
        if (issue.type === 'array') {
          return { message: t('reach.validation.selectAtLeast', { min }) };
        }
        return { message: t('reach.validation.tooSmallNumber', { min }) };
      }
      case z.ZodIssueCode.too_big: {
        const max = Number(issue.maximum);
        if (issue.type === 'string') return { message: t('reach.validation.tooLong', { max }) };
        if (issue.type === 'number') return { message: t('reach.validation.tooBigNumber', { max }) };
        return { message: t('reach.validation.invalid') };
      }
      case z.ZodIssueCode.invalid_string: {
        if (issue.validation === 'email') return { message: t('reach.validation.invalidEmail') };
        if (issue.validation === 'url') return { message: t('reach.validation.invalidUrl') };
        return { message: t('reach.validation.invalid') };
      }
      default:
        return { message: ctx.defaultError };
    }
  };
}

/**
 * The second argument of `zodResolver(schema, ...)`. The resolver types it as
 * zod's full ParseParams, so `path` and `async` are present even though only
 * the error map matters (the resolver parses asynchronously whatever `async` says).
 */
export function createReachSchemaOptions(t: Translate) {
  return { errorMap: createReachErrorMap(t), path: [] as Array<string | number>, async: false };
}
