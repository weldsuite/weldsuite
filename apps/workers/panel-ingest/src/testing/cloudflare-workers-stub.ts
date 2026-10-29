/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module,
 * which the runtime provides and vitest's node environment cannot resolve.
 * Wired in through `resolve.alias` in vitest.config.ts. Tests construct the
 * Durable Objects with a fake `ctx` (./fakes.ts).
 */
export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}
