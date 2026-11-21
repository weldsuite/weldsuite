/**
 * `FormCounters`: one Durable Object per form (`idFromName(formId)`) holding
 * its views per day, rate-limit windows and wrong-code counts. The rules are
 * `CounterRules` (../lib/counters.ts); a Durable Object runs one call at a
 * time, so each rule reads and writes as one step and parallel requests cannot
 * slip past a limit or the five-try lock.
 */

import { DurableObject } from 'cloudflare:workers';
import { CounterRules, type CodeCheck, type CounterStore, type RateCheck } from '../lib/counters';
import type { Env } from '../types';

export class FormCounters extends DurableObject<Env> {
  private readonly rules: CounterRules;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.rules = new CounterRules(ctx.storage as unknown as CounterStore);
  }

  recordView(day: string, viewKey: string): Promise<boolean> {
    return this.rules.recordView(day, viewKey);
  }

  viewsByDay(from: string, to: string): Promise<Record<string, number>> {
    return this.rules.viewsByDay(from, to);
  }

  rateLimit(scope: string, limit: number, windowSeconds: number): Promise<RateCheck> {
    return this.rules.rateLimit(scope, limit, windowSeconds);
  }

  tries(scope: string): Promise<number> {
    return this.rules.tries(scope);
  }

  attempt(scope: string, match: boolean): Promise<CodeCheck> {
    return this.rules.attempt(scope, match);
  }
}
