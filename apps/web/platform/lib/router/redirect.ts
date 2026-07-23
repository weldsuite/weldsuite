import { redirect as tanstackRedirect } from '@tanstack/react-router';

/**
 * Compat layer: drop-in replacement for `redirect()` from `next/navigation`.
 * Throws a TanStack Router redirect.
 */
export function redirect(path: string): never {
  throw tanstackRedirect({ to: path });
}
