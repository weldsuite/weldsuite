/**
 * Errors the services throw and `handle()` turns into the JSON error envelope:
 * `{ error: { code, message, details? } }`.
 */

import type { Context } from 'hono';

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 502 | 503;

export class FormsError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'FormsError';
  }
}

export const notFound = (what: string) => new FormsError(404, 'NOT_FOUND', `${what} not found`);

export function errorResponse(c: Context, err: FormsError): Response {
  const body: { error: { code: string; message: string; details?: unknown } } = {
    error: { code: err.code, message: err.message },
  };
  if (err.details !== undefined) body.error.details = err.details;
  return c.json(body, err.status);
}

/** Runs a handler and answers a thrown `FormsError` as its envelope; anything else is a 500 from the app. */
export async function handle(c: Context, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof FormsError) return errorResponse(c, err);
    throw err;
  }
}
