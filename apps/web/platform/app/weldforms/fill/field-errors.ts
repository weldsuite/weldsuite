import { isApiError } from '@weldsuite/api-client';
import type { AnswerError } from '@weldsuite/forms-engine';

/** The per-field errors of a 422 `VALIDATION_FAILED`, or null for any other failure. */
export function fieldErrorsOf(err: unknown): Record<string, AnswerError> | null {
  if (!isApiError(err) || err.status !== 422) return null;
  const body = err.body as { error?: { code?: string; details?: { fields?: Record<string, AnswerError> } } } | undefined;
  const fields = body?.error?.details?.fields;
  if (body?.error?.code !== 'VALIDATION_FAILED' || !fields || typeof fields !== 'object') return null;
  return fields;
}
