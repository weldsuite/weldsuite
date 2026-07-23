/**
 * Standardized Response Helpers
 *
 * Provides consistent response formats across all API routes.
 */

import type { Context } from 'hono';

// ============================================================================
// Response Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * Create pagination metadata from counts
 */
export function createPaginationMeta(
  page: number,
  pageSize: number,
  totalCount: number
): PaginationMeta {
  const totalPages = Math.ceil(totalCount / pageSize);
  return {
    page,
    pageSize,
    totalCount,
    totalPages,
    hasMore: page < totalPages,
  };
}

// ============================================================================
// Success Responses
// ============================================================================

/**
 * Return a success response with data
 */
export function success<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ success: true, data }, status);
}

/**
 * Return a paginated response
 */
export function paginated<T>(
  c: Context,
  data: T[],
  pagination: PaginationMeta
) {
  return c.json({
    success: true,
    data,
    pagination,
  });
}

// ============================================================================
// Error Responses
// ============================================================================

export const error = {
  /**
   * 400 Bad Request - Invalid input or validation error
   */
  badRequest: (c: Context, message: string, details?: unknown) =>
    c.json(
      {
        success: false,
        error: { code: 'BAD_REQUEST', message, details },
      },
      400
    ),

  /**
   * 401 Unauthorized - Missing or invalid widget authentication
   */
  unauthorized: (c: Context, message = 'Unauthorized') =>
    c.json(
      {
        success: false,
        error: { code: 'UNAUTHORIZED', message },
      },
      401
    ),

  /**
   * 403 Forbidden - Widget disabled or not allowed
   */
  forbidden: (c: Context, message = 'Forbidden') =>
    c.json(
      {
        success: false,
        error: { code: 'FORBIDDEN', message },
      },
      403
    ),

  /**
   * 404 Not Found - Resource doesn't exist
   */
  notFound: (c: Context, resource: string, id?: string) =>
    c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: id
            ? `${resource} with ID '${id}' not found`
            : `${resource} not found`,
        },
      },
      404
    ),

  /**
   * 500 Internal Server Error - Unexpected error
   */
  internal: (c: Context, message = 'Internal server error') =>
    c.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message },
      },
      500
    ),
};
