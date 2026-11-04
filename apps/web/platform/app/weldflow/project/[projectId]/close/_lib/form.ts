/**
 * Form plumbing shared by the close and templates screens: the Zod error map
 * that puts the shared schemas' failures in the user's language, and the
 * lesson form schema (the shared request schema's own field rules).
 */

import { z } from 'zod';
import { createLessonSchema } from '@weldsuite/app-api-client/schemas/project-closing';
import type { ClosingCopy, Format } from './close';

export type ValidationCopy = ClosingCopy['shared']['validation'];

/** Turns Zod's issues into messages: the shared schemas carry none of their own. */
export function closingErrorMap(copy: ValidationCopy, format: Format): z.ZodErrorMap {
  return (issue, ctx) => {
    switch (issue.code) {
      case z.ZodIssueCode.invalid_type:
        return { message: issue.received === 'undefined' || issue.received === 'null' ? copy.required : copy.invalidValue };
      case z.ZodIssueCode.too_small:
        return { message: issue.type === 'string' ? copy.required : copy.invalidValue };
      case z.ZodIssueCode.too_big:
        return { message: issue.type === 'string' ? format(copy.tooLong, { max: String(issue.maximum) }) : copy.invalidValue };
      case z.ZodIssueCode.invalid_enum_value:
        return { message: copy.required };
      case z.ZodIssueCode.custom: {
        const code = (issue.params as { code?: keyof ValidationCopy } | undefined)?.code;
        return { message: code ? copy[code] : ctx.defaultError };
      }
      default:
        return { message: ctx.defaultError };
    }
  };
}

/** The `schemaOptions` of `zodResolver`, in the full shape its types ask for. */
export function closingResolverOptions(copy: ValidationCopy, format: Format) {
  return { errorMap: closingErrorMap(copy, format), path: [] as (string | number)[], async: true };
}

const lessonShape = createLessonSchema.shape;

/** The fields of a lesson as the form holds them. */
export const lessonFormSchema = z.object({
  category: lessonShape.category,
  text: lessonShape.text,
});
export type LessonFormValues = z.infer<typeof lessonFormSchema>;
