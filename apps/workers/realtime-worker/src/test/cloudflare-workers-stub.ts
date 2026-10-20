/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module.
 *
 * The real module is provided by the Cloudflare runtime and cannot resolve under
 * vitest's node environment, so a test that imports `src/index.ts` (which
 * re-exports the Durable Object classes) would fail to load. This gives the
 * classes a base to extend. Wired in via `resolve.alias` in vitest.config.ts.
 */
export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
