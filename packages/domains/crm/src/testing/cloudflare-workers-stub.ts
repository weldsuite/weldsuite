/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module.
 *
 * The real module is provided by the Cloudflare runtime and cannot resolve
 * under vitest's node environment, so a worker test that (transitively)
 * imports `@weldsuite/crm-domain/workflows/execute-sequence` (e.g. the worker's
 * `src/index.ts`, which re-exports the workflow class) would fail to load.
 * This provides just enough shape for the import to succeed; tests never
 * instantiate a workflow.
 *
 * Wire it in via `resolve.alias['cloudflare:workers']` in the worker's
 * vitest.config.ts (same pattern as apps/workers/workspace-worker).
 */
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
  // Params is part of the real generic signature; referenced so the type
  // parameter isn't reported as unused.
  declare protected __params?: Params;
}

export type WorkflowEvent<T> = { payload: T; timestamp: Date; instanceId: string };

export type WorkflowStep = {
  do: <T>(name: string, ...rest: unknown[]) => Promise<T>;
  sleep: (name: string, duration: string | number) => Promise<void>;
  waitForEvent: (name: string, options: { type: string; timeout?: string | number }) => Promise<unknown>;
};
