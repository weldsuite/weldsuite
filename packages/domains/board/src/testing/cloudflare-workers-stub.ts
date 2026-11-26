/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module,
 * which cannot resolve under vitest's node environment. BoardRoom (room/board-room.ts)
 * extends `DurableObject`, so its tests need this; vitest.config.ts aliases
 * it. The tests build the object with a fake `ctx` (see room/board-room.test.ts).
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The `BoardsInternal` entrypoint extends this; tests call its `fetch` directly. */
export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
