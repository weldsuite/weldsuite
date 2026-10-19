/**
 * Test-environment stub for the Workers-only `cloudflare:workflows` module,
 * which provides `NonRetryableError` (the documented way to fail a Workflow
 * step without retries). Same shape as the runtime's: an Error whose optional
 * second argument becomes its `name`. Wired in via `resolve.alias` in
 * vitest.config.ts.
 */
export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? 'NonRetryableError';
  }
}
