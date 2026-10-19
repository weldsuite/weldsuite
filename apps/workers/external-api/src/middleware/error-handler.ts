import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { classifyMovedDatabaseError, workspaceMovingResponse } from '@weldsuite/worker-kit/workspace-moving';
import type { HonoEnv } from '../types';
import { forgetWorkspaceDetails } from '../lib/workspace-cache';

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
 *
 * A tenant database that moved under the request (source set read-only, 25006;
 * role password rotated, 28P01) is not a bug of ours: it is answered with
 * 503 WORKSPACE_MOVING + `Retry-After` (TASK-1150). A rotated password also
 * means the cached tenant URL is dead, so the workspace's cache entry is
 * dropped and the next request resolves it from master again.
 */
export const errorHandler = async (err: Error, c: Context<HonoEnv>): Promise<Response> => {
  // Only a classification is logged, never the error: its message can carry
  // the query and the role name.
  const moved = classifyMovedDatabaseError(err);
  if (moved) {
    const workspaceId = c.get('apiSession')?.workspaceId;
    console.warn(`[external-api] workspace database moved (${moved}), workspace ${workspaceId ?? 'unknown'}`);
    if (moved === 'password_rotated' && workspaceId) await forgetWorkspaceDetails(c.env?.API_CACHE, workspaceId);
    return workspaceMovingResponse(c);
  }

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
