/**
 * Standardized response helpers — identical shape to core-api so that
 * @weldsuite/core-api-client schemas/clients work against both workers.
 *
 *   { data: T }
 *   { data: T[], pagination: { cursor?, hasMore, totalCount } }
 *   { error: { code, message, details? } }
 */

import type { Context } from 'hono';

export interface PaginationMeta {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export function cursorPagination(
  totalCount: number,
  hasMore: boolean,
  cursor: string | null,
): PaginationMeta {
  return { totalCount, hasMore, cursor };
}

export function success<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ data }, status);
}

export function list<T>(c: Context, data: T[], pagination: PaginationMeta) {
  return c.json({ data, pagination });
}

export function noContent(_c: Context) {
  return new Response(null, { status: 204 });
}

export const error = {
  badRequest: (c: Context, message: string, details?: unknown) =>
    c.json({ error: { code: 'BAD_REQUEST', message, details } }, 400),

  unauthorized: (c: Context, message = 'Unauthorized') =>
    c.json({ error: { code: 'UNAUTHORIZED', message } }, 401),

  forbidden: (c: Context, message = 'Forbidden') =>
    c.json({ error: { code: 'FORBIDDEN', message } }, 403),

  notFound: (c: Context, resource: string, id?: string) =>
    c.json({
      error: {
        code: 'NOT_FOUND',
        message: id ? `${resource} with ID '${id}' not found` : `${resource} not found`,
      },
    }, 404),

  conflict: (c: Context, message: string, details?: unknown) =>
    c.json({ error: { code: 'CONFLICT', message, details } }, 409),

  /** Prepaid wallet exhausted — client should offer a credit topup. */
  insufficientCredits: (c: Context, details?: { currentBalance?: number; required?: number; shortfall?: number }) =>
    c.json(
      {
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: 'Insufficient credits. Top up your workspace balance to continue.',
          details,
        },
      },
      402,
    ),

  internal: (c: Context, message = 'Internal server error') =>
    c.json({ error: { code: 'INTERNAL_ERROR', message } }, 500),

  /** Helper for routes that require an authenticated workspace context. */
  orgRequired: (c: Context) =>
    c.json({ error: { code: 'ORG_REQUIRED', message: 'Organization context required' } }, 400),
};
