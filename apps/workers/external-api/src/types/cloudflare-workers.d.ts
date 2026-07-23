/**
 * Type declarations for cloudflare:workers module
 * This module is provided by the Cloudflare Workers runtime
 */
declare module 'cloudflare:workers' {
  /**
   * Base class for Durable Objects
   * @see https://developers.cloudflare.com/durable-objects/
   */
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;

    constructor(ctx: DurableObjectState, env: Env);
  }
}
