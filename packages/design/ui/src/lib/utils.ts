import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Message for a caught value. `catch` bindings are `unknown`, and a thrown
 * value is not guaranteed to be an Error, so read `.message` through here
 * instead of asserting the shape at each call site.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === 'string' && error) return error;
  return fallback;
}
