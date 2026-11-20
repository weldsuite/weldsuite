/** Test-environment stub for the Workers-only `cloudflare:workflows` module (see vitest.config.ts). */
export class NonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') {
    super(message);
    this.name = name;
  }
}
