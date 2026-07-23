import { notFound as tanstackNotFound } from '@tanstack/react-router';

/**
 * Compat layer: drop-in replacement for `notFound()` from `next/navigation`.
 * Throws a TanStack Router notFound.
 */
export function notFound(): never {
  throw tanstackNotFound();
}
