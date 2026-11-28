/**
 * Test stub for the Workers-only `cloudflare:workers` module. `CollabRoom`
 * (`../durable-room.ts`) extends its `DurableObject`, which the Workers
 * runtime provides and vitest's node environment can't resolve. This gives
 * the import just enough shape for tests to construct a room with
 * `new Room(ctx, env)`. collab-rooms swaps in its own runtime on Node.
 *
 * Wired in with `resolve.alias['cloudflare:workers']` in the vitest configs of
 * this package and of the docs, sheets and board domains.
 */
export class DurableObject<Env = unknown> {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
