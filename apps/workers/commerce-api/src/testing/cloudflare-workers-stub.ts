/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module.
 *
 * The real module is provided by the Cloudflare runtime and cannot resolve
 * under vitest's node environment. src/index.ts re-exports the
 * `PortalRateLimiter` Durable Object, which extends `DurableObject`, so any test
 * that loads the worker entry needs this. Wire it in via
 * `resolve.alias['cloudflare:workers']` in vitest.config.ts. Tests that exercise
 * the object construct it with a fake `ctx` (see portal-rate-limiter.test.ts).
 */
export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}
