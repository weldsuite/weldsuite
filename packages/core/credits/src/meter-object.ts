/**
 * `UsageMeter`: one Durable Object per workspace (`idFromName(workspaces.id)`)
 * holding its usage meters (./meters.ts). Hosted by mail-api (re-exported from
 * its src/index.ts, the module worker that deploys before every binder) and
 * bound as `USAGE_METER` by name from the workers that meter.
 *
 * Storage, per UTC month:
 *   `m:<YYYY-MM>:<meter>` → { used, blocksCharged }
 *   `k:<YYYY-MM>:<idempotencyKey>` → the answer given, so a retry gets it again
 *   `chargeSeq` → overage charges made, numbering their ledger idempotency keys
 * Idempotency keys older than last month are pruned once a month.
 *
 * Calls are handled one at a time (a promise chain), including the wallet
 * charge in the master DB, so two calls never pay for the same block and
 * nothing counts into a block whose payment is still in flight. The plan's
 * limits come from the master DB, cached for a minute. When the master DB
 * cannot be reached the unit is counted and allowed (fail-open); a block that
 * could not be charged stays unpaid, so the next unit charges it.
 */

import { DurableObject } from 'cloudflare:workers';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { consumeCredits, refundCredits, type ConsumeCreditsResult } from './index';
import {
  METERS,
  METER_KEYS,
  decideMeter,
  loadMeterLimits,
  meterPeriod,
  type MeterCounter,
  type MeterDecision,
  type MeterKey,
  type MeterLimits,
  type MeterReservation,
  type MeterUsageParams,
  type MeterUsageResult,
  type MeterUsageSummary,
} from './meters';

export interface UsageMeterHostEnv {
  DATABASE_URL_MASTER: string;
}

const LIMITS_TTL_MS = 60_000;
const ZERO: MeterCounter = { used: 0, blocksCharged: 0 };
/** How many overage charges this meter has made, numbering their ledger idempotency keys. */
const CHARGE_SEQ_KEY = 'chargeSeq';

const counterKey = (period: string, meter: MeterKey) => `m:${period}:${meter}`;
const idempotencyKeyOf = (period: string, key: string) => `k:${period}:${key}`;

/** The month before a `YYYY-MM` month. */
function previousPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return meterPeriod(new Date(Date.UTC(year, month - 2, 1)));
}

export class UsageMeter extends DurableObject<UsageMeterHostEnv> {
  private queue: Promise<unknown> = Promise.resolve();
  private limits: { workspaceId: string; at: number; value: Record<MeterKey, MeterLimits> } | null = null;
  private prunedFor: string | null = null;

  /** Run `fn` after every call before it has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The plan's limits (cached a minute); `null` when the master DB can't be read. */
  private async planLimits(workspaceId: string, now: number): Promise<Record<MeterKey, MeterLimits> | null> {
    const cached = this.limits;
    if (cached && cached.workspaceId === workspaceId && now - cached.at < LIMITS_TTL_MS) return cached.value;
    try {
      const value = await loadMeterLimits(getMasterDb(this.env), workspaceId);
      this.limits = { workspaceId, at: now, value };
      return value;
    } catch (err) {
      console.warn('[UsageMeter] plan limits unavailable:', err instanceof Error ? err.message : err);
      return cached?.workspaceId === workspaceId ? cached.value : null;
    }
  }

  /** Count units (see `meterUsage` in ./meters.ts). `now` is for tests. */
  meter(params: MeterUsageParams & { quantity: number; now?: number }): Promise<MeterUsageResult> {
    return this.serial(async () => {
      const now = params.now ?? Date.now();
      const period = meterPeriod(new Date(now));
      await this.pruneIdempotencyKeys(period);

      const storedKey = params.idempotencyKey ? idempotencyKeyOf(period, params.idempotencyKey) : null;
      if (storedKey) {
        const earlier = await this.ctx.storage.get<MeterUsageResult>(storedKey);
        if (earlier) return earlier;
      }

      const key = counterKey(period, params.meter);
      const counter = (await this.ctx.storage.get<MeterCounter>(key)) ?? ZERO;
      const reservation: MeterReservation = {
        workspaceId: params.workspaceId,
        meter: params.meter,
        period,
        quantity: params.quantity,
        idempotencyKey: params.idempotencyKey ?? null,
        blocks: 0,
        credits: 0,
        transactionId: null,
      };

      const limits = (await this.planLimits(params.workspaceId, now))?.[params.meter];
      if (!limits) {
        await this.ctx.storage.put(key, { ...counter, used: counter.used + params.quantity });
        return { allowed: true, reservation, used: counter.used + params.quantity, allowance: null, creditsCharged: 0 };
      }

      const decision = decideMeter(params.meter, counter, params.quantity, limits);
      const denied = (reason: 'limit_reached' | 'insufficient_credits') => ({
        allowed: false as const,
        reason,
        meter: params.meter,
        used: counter.used,
        allowance: limits.allowance,
        planName: limits.planName,
      });
      if (decision.kind === 'limit_reached') return denied('limit_reached');

      let next: MeterCounter = { ...counter, used: decision.used };
      let chargeSeq: number | null = null;
      if (decision.kind === 'charge') {
        const paid = await this.payOverage(params, period, decision, limits.allowance);
        if (paid && !paid.settle.ok) {
          return { ...denied('insufficient_credits'), required: paid.settle.required, currentBalance: paid.settle.currentBalance };
        }
        if (paid?.settle.ok) {
          next = { used: decision.used, blocksCharged: decision.blocksCharged };
          chargeSeq = paid.chargeSeq;
          reservation.blocks = decision.blocks;
          reservation.credits = decision.credits;
          reservation.transactionId = paid.settle.transactionId;
        }
      }

      const result: MeterUsageResult = {
        allowed: true,
        reservation,
        used: next.used,
        allowance: limits.allowance,
        creditsCharged: reservation.credits,
      };
      const writes: Record<string, unknown> = { [key]: next };
      if (storedKey) writes[storedKey] = result;
      if (chargeSeq !== null) writes[CHARGE_SEQ_KEY] = chargeSeq;
      await this.ctx.storage.put(writes);
      return result;
    });
  }

  /**
   * Pay the blocks a `charge` decision opens from the wallet. `null` when the
   * charge failed: the unit is counted and allowed, and the block stays unpaid
   * so the next unit charges it.
   */
  private async payOverage(
    params: MeterUsageParams,
    period: string,
    decision: Extract<MeterDecision, { kind: 'charge' }>,
    allowance: number | null,
  ): Promise<{ settle: ConsumeCreditsResult; chargeSeq: number } | null> {
    const def = METERS[params.meter];
    const chargeSeq = ((await this.ctx.storage.get<number>(CHARGE_SEQ_KEY)) ?? 0) + 1;
    try {
      const settle = await consumeCredits(getMasterDb(this.env), {
        workspaceId: params.workspaceId,
        amount: decision.credits,
        serviceType: def.serviceType,
        // Numbered charges: a crash between paying and saving re-uses the
        // number on the next call, so the block is never paid twice.
        idempotencyKey: `meter:${params.workspaceId}:${chargeSeq}`,
        referenceId: params.referenceId,
        referenceType: params.referenceType,
        description: `${decision.blocks * def.blockSize} extra ${def.unitPlural} (${period})`,
        metadata: { meter: params.meter, period, blocks: decision.blocks, blockSize: def.blockSize, used: decision.used, allowance },
        userId: params.userId,
      });
      return { settle, chargeSeq };
    } catch (err) {
      console.warn('[UsageMeter] overage charge failed, allowing:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Hand back what one `meter` call counted, refunding the blocks it paid for. */
  release(reservation: MeterReservation): Promise<void> {
    return this.serial(async () => {
      const key = counterKey(reservation.period, reservation.meter);
      const counter = (await this.ctx.storage.get<MeterCounter>(key)) ?? ZERO;
      const paid = reservation.blocks > 0 && reservation.transactionId !== null;
      if (paid) {
        await refundCredits(getMasterDb(this.env), {
          workspaceId: reservation.workspaceId,
          amount: reservation.credits,
          serviceType: METERS[reservation.meter].serviceType,
          idempotencyKey: `meter-release:${reservation.transactionId}`,
          referenceId: reservation.transactionId ?? undefined,
          referenceType: 'credit_transaction',
          description: `Refund: ${METERS[reservation.meter].unitPlural} not used`,
        });
      }
      await this.ctx.storage.put(key, {
        used: Math.max(0, counter.used - reservation.quantity),
        blocksCharged: Math.max(0, counter.blocksCharged - (paid ? reservation.blocks : 0)),
      });
      if (reservation.idempotencyKey) await this.ctx.storage.delete(idempotencyKeyOf(reservation.period, reservation.idempotencyKey));
    });
  }

  /** This month's use of every meter. `now` is for tests. */
  async usage(workspaceId: string, now: number = Date.now()): Promise<MeterUsageSummary[]> {
    const period = meterPeriod(new Date(now));
    const limits = await this.planLimits(workspaceId, now);
    const counters = await this.ctx.storage.get<MeterCounter>(METER_KEYS.map((meter) => counterKey(period, meter)));
    return METER_KEYS.map((meter) => {
      const def = METERS[meter];
      const counter = counters.get(counterKey(period, meter)) ?? ZERO;
      const limit = limits?.[meter];
      return {
        meter,
        unit: def.unit,
        period,
        used: counter.used,
        allowance: limit ? limit.allowance : null,
        allowOverage: limit?.allowOverage ?? false,
        blockSize: def.blockSize,
        creditsPerBlock: def.creditsPerBlock,
        overageCredits: counter.blocksCharged * def.creditsPerBlock,
      };
    });
  }

  /** Once a month: drop idempotency keys from before last month. */
  private async pruneIdempotencyKeys(period: string): Promise<void> {
    if (this.prunedFor === period) return;
    this.prunedFor = period;
    const keep = `k:${previousPeriod(period)}`;
    for (;;) {
      const old = await this.ctx.storage.list({ prefix: 'k:', end: keep, limit: 500 });
      if (old.size === 0) return;
      await this.ctx.storage.delete([...old.keys()]);
    }
  }
}
