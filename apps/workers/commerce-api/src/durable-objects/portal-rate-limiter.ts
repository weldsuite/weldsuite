/**
 * PortalRateLimiter: the atomic counter behind the public portal limits
 * (/auth/request, /auth/verify). One instance per limiter key
 * (`PORTAL_RATE_LIMITER.idFromName(rateLimitKey(workspaceId, key))`).
 *
 * A Durable Object handles one call at a time, so "read the count, compare,
 * write the count" cannot interleave, unlike the KV counter it replaces. The
 * logic lives in `RateLimitCounter` (@weldsuite/commerce-domain/portal-tokens),
 * which the tests drive directly; this class only wires it to the object's
 * storage. An alarm at the end of each window wipes the storage, so an idle key
 * costs nothing.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  RateLimitCounter,
  type RateLimitState,
  type RateLimitVerdict,
} from '@weldsuite/commerce-domain/portal-tokens';

const STATE_KEY = 'window';

export class PortalRateLimiter extends DurableObject {
  private readonly counter: RateLimitCounter;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.counter = new RateLimitCounter({
      load: () => storage.get<RateLimitState>(STATE_KEY),
      save: (state) => storage.put(STATE_KEY, state),
      setAlarm: (at) => storage.setAlarm(at),
      clear: () => storage.deleteAll(),
    });
    // Nothing is served until the stored window is in memory.
    void ctx.blockConcurrencyWhile(() => this.counter.load());
  }

  /** Count one hit. Called over RPC by `consumeRateLimit`. */
  hit(max: number, windowSeconds: number): Promise<RateLimitVerdict> {
    return this.counter.hit(max, windowSeconds);
  }

  async alarm(): Promise<void> {
    await this.counter.alarm();
  }
}
