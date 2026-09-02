/**
 * Test-environment stub for the Workers-only `cloudflare:email` module.
 *
 * The real module is provided by the Cloudflare runtime and cannot resolve
 * under vitest's node environment, so any route that transitively imports
 * `src/lib/cloudflare-email.ts` (e.g. via the `_auth-gates` sweep) would fail
 * to load. This provides just enough shape for the import to succeed; tests
 * never actually send email.
 *
 * Wired in via `resolve.alias['cloudflare:email']` in vitest.config.ts.
 */
export class EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: unknown;
  constructor(from: string, to: string, raw: unknown) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}
