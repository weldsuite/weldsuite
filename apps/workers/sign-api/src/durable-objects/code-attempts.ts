/**
 * `SignCodeAttempts`: one per signing link (`idFromName(tokenHash)`), counting
 * wrong access and email codes. A Durable Object runs one call at a time and
 * storage awaits do not let another call in, so `attempt` reads and writes
 * the count as one step: parallel `/verify` calls cannot all slip in under
 * the lock, as they could with the read-then-write on KV it replaces.
 *
 * The rule itself is `AttemptCounter` (services/codes.ts). An alarm drops the
 * stored count once its 15-minute window has passed, so idle links keep no state.
 */

import { DurableObject } from 'cloudflare:workers';
import { AttemptCounter, type AttemptStore, type CodeCheck } from '../services/codes';
import type { Env } from '../types';

export class SignCodeAttempts extends DurableObject<Env> {
  private readonly counter: AttemptCounter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.counter = new AttemptCounter(ctx.storage as unknown as AttemptStore);
  }

  async tries(): Promise<number> {
    return this.counter.tries();
  }

  async attempt(match: boolean): Promise<CodeCheck> {
    const result = await this.counter.attempt(match);
    const until = await this.counter.expiresAt();
    if (until === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(until);
    return result;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** The counter for one link, through its Durable Object. */
export function codeAttemptsFor(ns: DurableObjectNamespace<SignCodeAttempts>, tokenHash: string) {
  const stub = ns.get(ns.idFromName(tokenHash));
  return {
    tries: () => stub.tries(),
    attempt: (match: boolean): Promise<CodeCheck> => stub.attempt(match),
  };
}
