/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module,
 * which cannot resolve under vitest's node environment. src/index.ts
 * re-exports the SheetRoom Durable Object (it extends `DurableObject`), so any
 * test loading the worker entry needs this; vitest.config.ts aliases it.
 * Room tests build the object with a fake `ctx` (see sheet-room.test.ts).
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The `SheetsInternal` entrypoint extends this; tests call its `fetch` directly. */
export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
