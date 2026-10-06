/**
 * Hook for `zValidator(target, schema, validationHook)`.
 *
 * Without a hook, @hono/zod-validator answers a failed parse with its own
 * `{ success: false, error: { issues, name: 'ZodError' } }`. That is not the
 * API's error envelope, and a client reading `error.message` finds nothing
 * there. This answers 400 in the standard shape instead:
 *
 *   { error: { code: 'BAD_REQUEST', message: 'availability.monday: …', details: { issues } } }
 */

import type { Context, Env } from 'hono';
import { error } from '@weldsuite/worker-kit/response';

interface ValidationResult {
  success: boolean;
  error?: { issues: Array<{ path: Array<string | number>; message: string }> };
}

// Generic over the route's env and path, so passing the hook does not widen
// the handler's `c` (a plain `Context` would turn `c.req.param('id')` into
// `string | undefined`).
export function validationHook<E extends Env, P extends string>(
  result: ValidationResult,
  c: Context<E, P>,
) {
  if (result.success) return;
  const issues = (result.error?.issues ?? []).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  const message = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
  return error.badRequest(c, message || 'Invalid request', { issues });
}
