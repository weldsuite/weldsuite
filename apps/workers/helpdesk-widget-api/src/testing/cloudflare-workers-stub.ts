/**
 * Test stub for the Workers-only `cloudflare:workers` module, which cannot
 * resolve under vitest's node environment. src/index.ts re-exports the
 * PortalRateLimiter Durable Object (it extends `DurableObject`), so any test
 * that loads the worker entry needs it. Wired in by vitest.config.ts.
 */
export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}
