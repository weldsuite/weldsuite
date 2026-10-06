/**
 * Engine error types.
 */

/**
 * Thrown by every not-yet-implemented engine skeleton. The TDD suite expects
 * these to disappear as the implementation lands.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

/** No integration of the requested type/id exists in the workspace. */
export class IntegrationNotFoundError extends Error {
  constructor(selector: string) {
    super(`Integration not found: ${selector}`);
    this.name = 'IntegrationNotFoundError';
  }
}

/** Integration exists but is not in a usable (connected) state. */
export class IntegrationNotConnectedError extends Error {
  constructor(selector: string, status: string) {
    super(`Integration ${selector} is not connected (status: ${status})`);
    this.name = 'IntegrationNotConnectedError';
  }
}

/**
 * A step failure that retrying cannot fix (bad input, a validation rejection
 * from a downstream service, a missing configuration). The engine's retry loop
 * stops on it immediately and the durable runtime must not retry it either.
 * `details` carries the raw provider payload for the step row.
 */
export class NonRetryableStepError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'NonRetryableStepError';
    this.details = details;
  }
}

/**
 * True for a non-retryable failure. Matches on `name` as well as `instanceof`:
 * an error that crossed a Cloudflare Workflows step boundary is rebuilt from
 * its serialised form and loses its prototype. Cloudflare's own
 * `NonRetryableError` name is deliberately NOT matched: the step runtime
 * throws every failed action attempt as one (see step-runtime.ts), so it says
 * nothing about whether the engine may retry.
 */
export function isNonRetryableError(err: unknown): boolean {
  if (err instanceof NonRetryableStepError) return true;
  return err instanceof Error && err.name === 'NonRetryableStepError';
}

/** Raw provider payload attached to a failure, if any. */
export function errorDetails(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'details' in err
    ? (err as { details?: unknown }).details
    : undefined;
}
