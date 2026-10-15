import { z } from 'zod';
import { brEntityErrors, type BrEntityErrorCode, type BrEntityValues } from '@/lib/weldbooks/br-entity';
import type { BrEntityFieldErrors } from './br-entity-cards';

/** The messages of the BR field checks (`weldbooksBr.entity.errors`). */
export type BrEntityErrorMessages = Record<BrEntityErrorCode, string>;

/**
 * Adds an issue per invalid BR field to a Zod refinement, under `path` (the
 * `br` object of the form, or the identifier fields it sits next to).
 */
export function addBrEntityIssues(
  ctx: z.RefinementCtx,
  values: BrEntityValues,
  context: { entityType: string | null | undefined; cnpj?: string; ie?: string },
  messages: BrEntityErrorMessages,
  paths: { br: (string | number)[]; cnpj: (string | number)[]; ie: (string | number)[] },
): void {
  const errors = brEntityErrors(values, context);
  for (const [key, code] of Object.entries(errors) as Array<[keyof BrEntityValues | 'cnpj' | 'ie', BrEntityErrorCode]>) {
    const path = key === 'cnpj' ? paths.cnpj : key === 'ie' ? paths.ie : [...paths.br, key];
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: messages[code] });
  }
}

/** The first message of every nested BR field error of the form state. */
export function brFieldErrors(errors: unknown): BrEntityFieldErrors {
  const out: BrEntityFieldErrors = {};
  if (!errors || typeof errors !== 'object') return out;
  for (const [key, value] of Object.entries(errors)) {
    const message = (value as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string') out[key as keyof BrEntityValues] = message;
  }
  return out;
}
