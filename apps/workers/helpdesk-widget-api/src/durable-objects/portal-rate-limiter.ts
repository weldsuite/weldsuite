/**
 * PortalRateLimiter: the atomic counter behind the help-center sign-in limits
 * (`/api/portal/auth/request`, `/api/portal/auth/verify`). One instance per
 * limiter key. A Durable Object handles one call at a time, so "count,
 * compare, write" cannot interleave the way it can in KV. The arithmetic is
 * the commerce portal's `RateLimitCounter`; this class wires it to storage.
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

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const storage = ctx.storage;
    this.counter = new RateLimitCounter({
      load: () => storage.get<RateLimitState>(STATE_KEY),
      save: (state) => storage.put(STATE_KEY, state),
      setAlarm: (at) => storage.setAlarm(at),
      clear: () => storage.deleteAll(),
    });
    void ctx.blockConcurrencyWhile(() => this.counter.load());
  }

  hit(max: number, windowSeconds: number): Promise<RateLimitVerdict> {
    return this.counter.hit(max, windowSeconds);
  }

  release(): Promise<void> {
    return this.counter.release();
  }

  async alarm(): Promise<void> {
    await this.counter.alarm();
  }
}
