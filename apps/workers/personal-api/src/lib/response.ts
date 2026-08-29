/**
 * Standardized response helpers — identical shape to app-api / core-api.
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
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: id ? `${resource} with ID '${id}' not found` : `${resource} not found`,
        },
      },
      404,
    ),

  conflict: (c: Context, message: string, details?: unknown) =>
    c.json({ error: { code: 'CONFLICT', message, details } }, 409),

  personalAccountRequired: (c: Context) =>
    c.json(
      {
        error: {
          code: 'PERSONAL_ACCOUNT_REQUIRED',
          message: 'Personal account required. Call POST /api/onboard first.',
        },
      },
      404,
    ),

  planLimit: (c: Context, message: string, details?: unknown) =>
    c.json({ error: { code: 'PLAN_LIMIT_REACHED', message, details } }, 403),

  internal: (c: Context, message = 'Internal server error') =>
    c.json({ error: { code: 'INTERNAL_ERROR', message } }, 500),

  unavailable: (c: Context, message: string) =>
    c.json({ error: { code: 'SERVICE_UNAVAILABLE', message } }, 503),
};
