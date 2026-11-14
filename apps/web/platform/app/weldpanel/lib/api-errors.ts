/**
 * Reads the API's error envelope (`{ error: { code, message, details } }`) the
 * way the recordings, summary and heatmap pages need: AI failures (402, 403,
 * 404) and the heatmap snapshot's two 404 codes.
 */

import { isApiError } from '@weldsuite/api-client';

interface ErrorBody {
  code?: string;
  details?: { requiredCredits?: number | null; availableCredits?: number | null };
}

function errorBody(error: unknown): ErrorBody {
  if (!isApiError(error)) return {};
  const body = error.body as { error?: ErrorBody | string } | undefined;
  return typeof body?.error === 'object' && body.error !== null ? body.error : {};
}

export function errorCode(error: unknown): string | null {
  return errorBody(error).code ?? null;
}

export type AiFailure =
  | { kind: 'credits'; required: number | null; available: number | null }
  | { kind: 'disabled' }
  | { kind: 'no-sessions' }
  | { kind: 'failed' };

/** Maps a failed summary call to what the panel should say. */
export function aiFailure(error: unknown): AiFailure {
  if (!isApiError(error)) return { kind: 'failed' };
  const body = errorBody(error);
  if (error.status === 402 || body.code === 'INSUFFICIENT_CREDITS') {
    return { kind: 'credits', required: body.details?.requiredCredits ?? null, available: body.details?.availableCredits ?? null };
  }
  if (error.status === 403 || body.code === 'AI_DISABLED') return { kind: 'disabled' };
  if (error.status === 404 || body.code === 'NO_SESSIONS') return { kind: 'no-sessions' };
  return { kind: 'failed' };
}

export type SnapshotFailure = 'requested' | 'unavailable' | 'failed';

export function snapshotFailure(error: unknown): SnapshotFailure {
  const code = errorCode(error);
  if (code === 'SNAPSHOT_REQUESTED') return 'requested';
  if (code === 'SNAPSHOT_UNAVAILABLE') return 'unavailable';
  return 'failed';
}

export function isNotFoundError(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}
