/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module,
 * which cannot resolve under vitest's node environment. DocRoom (room/doc-room.ts)
 * extends `DurableObject`, so its tests need this; vitest.config.ts aliases
 * it. The tests build the object with a fake `ctx` (see room/doc-room.test.ts).
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
