/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module,
 * wired in through `resolve.alias` in vitest.config.ts. Tests build the
 * Durable Objects with a fake `ctx` (./fakes.ts) and run the Workflow with a
 * fake step.
 */
export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  /** Never read; keeps `Params` in the type like the real class. */
  protected readonly __params?: Params;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}
