import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

function getErrorCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'RATE_LIMITED';
    case 500:
      return 'INTERNAL_ERROR';
    case 502:
      return 'BAD_GATEWAY';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'HTTP_ERROR';
  }
}

/**
 * Global error handler.
 *
 * Returns the unified envelope: `{ error: { code, message, details? } }`.
 */
export const errorHandler = (err: Error, c: Context) => {
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'Validation failed',
          details: err.issues,
        },
      },
      400,
    );
  }

  if (err instanceof HTTPException) {
    const status = err.status;
    return c.json(
      {
        error: {
          code: getErrorCode(status),
          message: err.message,
        },
      },
      status,
    );
  }

  console.error('[external-api] unhandled error:', err);

  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal server error occurred',
      },
    },
    500,
  );
};
