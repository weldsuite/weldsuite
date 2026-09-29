/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module.
 *
 * The real module is provided by the Cloudflare runtime and cannot resolve
 * under vitest's node environment, so a worker test that imports a `src/index.ts`
 * exporting a `WorkerEntrypoint` (the `<Name>Internal` classes) would fail to
 * load. This provides just enough shape for the import to succeed and for tests
 * to construct an entrypoint with `new Entrypoint(ctx, env)`.
 *
 * Wire it in via `resolve.alias['cloudflare:workers']` in the worker's
 * vitest.config.ts.
 */
export class WorkerEntrypoint<Env = unknown> {
  readonly ctx: ExecutionContext;
  readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
  declare protected __params?: Params;
}

export type WorkflowEvent<T> = { payload: T; timestamp: Date; instanceId: string };

export type WorkflowStep = {
  do: <T>(name: string, ...rest: unknown[]) => Promise<T>;
  sleep: (name: string, duration: string | number) => Promise<void>;
};
