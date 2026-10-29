/**
 * Test-environment stub for the Workers-only `cloudflare:workers` module.
 *
 * The real module is provided by the Cloudflare runtime and cannot resolve
 * under vitest's node environment. `storeEmail`'s object-mode tests
 * (`email-storage.store.test.ts`) construct a real `ObjectMailboxStore`
 * backed by `@weldsuite/mail-domain/store/object/testing/fake-env`'s fakes,
 * which instantiate the real `MailboxStoreObject` class
 * (`@weldsuite/mail-domain/mailbox-object`, `extends DurableObject<Env>`) —
 * this provides just enough shape for that import to succeed. The fake's own
 * `DurableObjectState` double (`@weldsuite/worker-kit/testing/durable-sqlite`)
 * is what actually backs the object's storage; this base class just needs to
 * hold `ctx`/`env` the way the real one does.
 *
 * Wired in via `resolve.alias['cloudflare:workers']` in vitest.config.ts, same
 * pattern as apps/workers/workspace-worker and `@weldsuite/mail-domain`'s own
 * `src/testing/cloudflare-workers-stub.ts`.
 */
export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}
