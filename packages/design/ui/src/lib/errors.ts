/**
 * Read a human-readable message off a caught value.
 *
 * `catch` bindings are `unknown`, and what lands there varies: an `Error`, a
 * rejected fetch payload shaped like `{ message }`, or a bare string. Callers
 * that just want text for the UI go through this instead of asserting a type.
 */
export function getErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  return fallback;
}
