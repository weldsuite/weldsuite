/**
 * `cloudflare:workers` and `cloudflare:workflows` for Vitest on Node: the
 * Workflow base class and the non-retryable error, enough to run
 * `ExecuteWorkflowWorkflow.run` with a fake `step` (./rust-fixtures.test.ts).
 * Aliased in ../../vitest.config.ts.
 */

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: unknown;
  protected env: Env;
  declare readonly __params?: Params;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class NonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') {
    super(message);
    this.name = name;
  }
}
