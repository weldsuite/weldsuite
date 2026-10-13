/**
 * The error every WeldReach domain function throws for a request it refuses.
 *
 * The domain knows nothing about HTTP frameworks: each worker catches
 * `ReachDomainError` and answers `{ error: { code, message, details? } }` with
 * `status`, so a code and a status mean the same thing on reach-api,
 * external-api and mcp-server. The codes of the standard cases match the
 * helpers of `@weldsuite/worker-kit/response` (`BAD_REQUEST`, `NOT_FOUND`,
 * `CONFLICT`, ...); domain states have their own (`CAMPAIGN_ACTIVE`,
 * `MAILBOX_LIMIT_REACHED`, ...) so a client can tell them apart.
 */

export type ReachDomainErrorStatus = 400 | 402 | 403 | 404 | 409 | 422 | 500 | 502 | 503;

export class ReachDomainError extends Error {
  readonly code: string;
  readonly status: ReachDomainErrorStatus;
  readonly details?: unknown;

  constructor(code: string, status: ReachDomainErrorStatus, message: string, details?: unknown) {
    super(message);
    this.name = 'ReachDomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** The standard refusals, with the codes and messages the API envelope uses. */
export const reachError = {
  badRequest: (message: string, details?: unknown) => new ReachDomainError('BAD_REQUEST', 400, message, details),

  forbidden: (message = 'Forbidden') => new ReachDomainError('FORBIDDEN', 403, message),

  notFound: (resource: string, id?: string) =>
    new ReachDomainError('NOT_FOUND', 404, id ? `${resource} with ID '${id}' not found` : `${resource} not found`),

  conflict: (message: string, details?: unknown) => new ReachDomainError('CONFLICT', 409, message, details),

  /** A 409 with its own code, so a client can tell "pause it first" from a plain conflict. */
  state: (code: string, message: string) => new ReachDomainError(code, 409, message),

  internal: (message = 'Internal server error') => new ReachDomainError('INTERNAL_ERROR', 500, message),

  /** An upstream provider we depend on failed; the request is retryable. */
  badGateway: (message = 'Upstream service error') => new ReachDomainError('UPSTREAM_ERROR', 502, message),

  unavailable: (message: string) => new ReachDomainError('SERVICE_UNAVAILABLE', 503, message),
};
