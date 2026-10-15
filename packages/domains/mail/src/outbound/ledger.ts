/**
 * The outbound guard's Durable Objects, hosted by mail-api (re-exported from
 * its src/index.ts) and bound by name from every worker that sends mail.
 *
 * - `OutboundLedger`: one per workspace or personal account
 *   (`idFromName(ledgerKeyFor(subject))`). Strongly consistent counters and
 *   decisions (LedgerCore), plus the I/O around them: the policy from the
 *   master DB (reloaded every minute), AI reviews onto the review queue,
 *   automatic state changes, cases and staff alerts. An alarm every 5 minutes
 *   recomputes the risk score while there is activity.
 * - `OutboundPlatformBudget`: one instance (`idFromName('platform')`). Customer
 *   recipients per UTC day across all workspaces, against the Cloudflare
 *   account quota; tripped at 70% or by a Cloudflare daily-limit error. Ledgers
 *   push their daily deltas from their alarms, never per send.
 *
 * See docs/plans/weldmail-outbound-abuse.md.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  OUTBOUND_DEFAULT_LIMITS,
  OUTBOUND_THRESHOLDS,
  type OutboundUsage,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import {
  LedgerCore,
  type AutomaticAction,
  type DeliveryEventType,
  type LedgerStore,
  type LedgerSubject,
  type ReserveDecision,
  type ReserveRequest,
  type ReviewRequest,
  type StoredVerdict,
} from './ledger-core';
import { applyAutomaticState, loadLedgerPolicy, recordOutboundEvent, saveRiskScore, type LoadedPolicy } from './policy-store';
import { openOutboundCase, type OutboundCaseEnv } from './cases';
import type { OutboundReviewMessage } from './review';

export interface OutboundLedgerEnv extends OutboundCaseEnv {
  /** Queue the AI template reviews go to (consumed by mail-api). */
  MAIL_OUTBOUND_REVIEW?: Queue<OutboundReviewMessage>;
  OUTBOUND_PLATFORM?: DurableObjectNamespace<OutboundPlatformBudget>;
  /** The Cloudflare account's daily Email Sending quota (recipients). Unset = no platform budget. */
  CF_EMAIL_DAILY_QUOTA?: string;
}

const POLICY_TTL_MS = 60_000;
const PLATFORM_TTL_MS = 60_000;
const ALARM_INTERVAL_MS = 5 * 60_000;

/** What the customer sees while a restriction set by the system is on. */
const CUSTOMER_REASONS: Record<'restricted' | 'hold', string> = {
  restricted: 'Sending is limited while WeldSuite reviews unusual activity from this workspace.',
  hold: 'New conversations are paused while WeldSuite reviews this workspace. Replies still go out.',
};

/** Used when the master DB can't be reached and no policy was loaded before: count, never block. */
function fallbackPolicy(): LoadedPolicy {
  return {
    mode: 'shadow',
    trustLevel: 'standard',
    state: 'active',
    stateReason: null,
    stateSetBy: null,
    stateSetAt: null,
    allowRepliesWhenSuspended: false,
    limits: { ...OUTBOUND_DEFAULT_LIMITS.standard },
    riskScore: 0,
  };
}

function subjectLabel(subject: LedgerSubject): Record<string, string> {
  return subject.kind === 'workspace'
    ? { workspaceId: subject.workspaceId }
    : { personalAccountId: subject.personalAccountId };
}

export class OutboundLedger extends DurableObject<OutboundLedgerEnv> {
  private readonly core: LedgerCore;
  private subject: LedgerSubject | null = null;
  private policy: LoadedPolicy | null = null;
  private policyLoadedAt = 0;
  private platformTripped = false;
  private platformCheckedAt = 0;
  private lastSavedRisk: number | null = null;

  constructor(ctx: DurableObjectState, env: OutboundLedgerEnv) {
    super(ctx, env);
    this.core = new LedgerCore(ctx.storage as unknown as LedgerStore);
    void ctx.blockConcurrencyWhile(async () => {
      await this.core.load();
      this.subject = (await ctx.storage.get<LedgerSubject>('subject')) ?? null;
    });
  }

  private async ensure(subject?: LedgerSubject, force = false): Promise<LoadedPolicy> {
    if (subject && !this.subject) {
      this.subject = subject;
      await this.ctx.storage.put('subject', subject);
    }
    if (!this.subject) return this.policy ?? fallbackPolicy();
    if (force || !this.policy || Date.now() - this.policyLoadedAt > POLICY_TTL_MS) {
      try {
        const rates = this.core.risk(this.policy ?? fallbackPolicy());
        this.policy = await loadLedgerPolicy(this.env, this.subject, {
          hardBounceRate7d: rates.hardBounceRate7d,
          complaintRate7d: rates.complaintRate7d,
        });
        this.policyLoadedAt = Date.now();
        if (this.lastSavedRisk === null) this.lastSavedRisk = this.policy.riskScore;
      } catch (err) {
        console.error('[outbound-ledger] policy load failed:', err instanceof Error ? err.message : err);
        if (!this.policy) this.policy = fallbackPolicy();
        // Retry soon, not on every request.
        this.policyLoadedAt = Date.now() - POLICY_TTL_MS + 10_000;
      }
    }
    return this.policy;
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  private async platformStatus(): Promise<boolean> {
    if (!this.env.OUTBOUND_PLATFORM) return false;
    if (Date.now() - this.platformCheckedAt < PLATFORM_TTL_MS) return this.platformTripped;
    try {
      const stub = this.env.OUTBOUND_PLATFORM.get(this.env.OUTBOUND_PLATFORM.idFromName('platform'));
      this.platformTripped = (await stub.status()).tripped;
    } catch (err) {
      console.warn('[outbound-ledger] platform status unavailable:', err instanceof Error ? err.message : err);
    }
    this.platformCheckedAt = Date.now();
    return this.platformTripped;
  }

  // ---- RPC ----------------------------------------------------------------

  async reserve(subject: LedgerSubject, request: ReserveRequest): Promise<ReserveDecision> {
    const policy = await this.ensure(subject);
    const decision = this.core.reserve({ policy, platformTripped: await this.platformStatus() }, request);
    const refused = decision.denial ?? decision.shadowDenial;
    if (refused) {
      console.log(
        JSON.stringify({
          event: decision.denial ? 'outbound_denied' : 'outbound_shadow_denied',
          ...subjectLabel(subject),
          sender: request.sender,
          source: request.source,
          kind: request.kind,
          recipients: request.recipients.length,
          firstContact: request.firstContact.length,
          code: refused.code,
          reason: refused.reason ?? null,
        }),
      );
    }
    await this.core.flush();
    await this.ensureAlarm();
    return decision;
  }

  async commit(reservationId: string, sentRecipients?: string[]): Promise<void> {
    const policy = await this.ensure();
    const { review } = this.core.commit(policy, reservationId, sentRecipients);
    await this.core.flush();
    if (review) await this.queueReview(review);
  }

  async release(reservationId: string): Promise<void> {
    this.core.release(reservationId);
  }

  async recordDelivery(subject: LedgerSubject, type: DeliveryEventType, atMs: number): Promise<void> {
    await this.ensure(subject);
    this.core.recordDelivery(type, atMs);
    await this.core.flush();
    await this.ensureAlarm();
  }

  async recordVerdict(verdict: StoredVerdict, opts: { staffRequested?: boolean } = {}): Promise<void> {
    const policy = await this.ensure();
    const actions = this.core.recordVerdict(verdict, opts);
    await this.core.flush();
    if (actions.length > 0) await this.applyActions(policy, actions, this.core.risk(policy).score);
  }

  async usage(subject: LedgerSubject): Promise<OutboundUsage> {
    return this.core.usage(await this.ensure(subject));
  }

  /** Staff view: risk, shadow-mode would-be denials (7 days) and the current policy. */
  async inspect(subject: LedgerSubject): Promise<{
    usage: OutboundUsage;
    riskScore: number;
    riskReasons: string[];
    shadowDenials7d: Record<string, number>;
  }> {
    const policy = await this.ensure(subject, true);
    const risk = this.core.risk(policy);
    return {
      usage: this.core.usage(policy),
      riskScore: risk.score,
      riskReasons: risk.reasons,
      shadowDenials7d: this.core.shadowCounts(),
    };
  }

  /** Staff asked for an AI review of today's biggest template. */
  async requestReview(subject: LedgerSubject): Promise<boolean> {
    const policy = await this.ensure(subject);
    const review = this.core.reviewTopTemplate(policy);
    await this.core.flush();
    if (!review) return false;
    await this.queueReview(review);
    return true;
  }

  /** Staff changed the policy: drop the cached copy. */
  async refreshPolicy(): Promise<void> {
    await this.ensure(undefined, true);
  }

  async alarm(): Promise<void> {
    if (!this.subject) return;
    const subject = this.subject;
    const policy = await this.ensure(undefined, true);
    const { risk, actions, review } = this.core.evaluate(policy);
    const pruned = this.core.prune();
    if (pruned.length > 0) await this.ctx.storage.delete(pruned);
    await this.core.flush();

    if (this.lastSavedRisk === null || Math.abs(risk.score - this.lastSavedRisk) >= 5) {
      try {
        await saveRiskScore(this.env, subject, risk.score);
        this.lastSavedRisk = risk.score;
      } catch (err) {
        console.error('[outbound-ledger] risk save failed:', err instanceof Error ? err.message : err);
      }
    }
    if (actions.length > 0) await this.applyActions(policy, actions, risk.score);
    if (review) await this.queueReview(review);
    await this.pushPlatform();

    if (this.core.hasRecentActivity()) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ---- internals ------------------------------------------------------------

  private async applyActions(policy: LoadedPolicy, actions: AutomaticAction[], riskScore: number): Promise<void> {
    const subject = this.subject;
    if (!subject) return;
    for (const action of actions) {
      let state = policy.state;
      if (action.kind === 'state') {
        try {
          await applyAutomaticState(this.env, subject, {
            from: policy.state,
            to: action.toState,
            customerReason: CUSTOMER_REASONS[action.toState],
            reason: action.reason,
            details: action.details,
          });
          state = action.toState;
          policy.state = action.toState;
          // Restricted limits and the hold come from the reloaded policy.
          this.policyLoadedAt = 0;
        } catch (err) {
          console.error('[outbound-ledger] state change failed:', err instanceof Error ? err.message : err);
        }
      }
      await openOutboundCase(this.env, {
        subject,
        trigger: action.trigger,
        severity: action.severity,
        summary: action.reason,
        riskScore,
        state,
        template: action.template,
        metrics: action.details,
      });
    }
  }

  private async queueReview(request: ReviewRequest): Promise<void> {
    if (!this.subject || !this.env.MAIL_OUTBOUND_REVIEW) return;
    try {
      await this.env.MAIL_OUTBOUND_REVIEW.send({
        subject: this.subject,
        request,
        requestedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[outbound-ledger] review enqueue failed:', err instanceof Error ? err.message : err);
    }
  }

  private async pushPlatform(): Promise<void> {
    if (!this.env.OUTBOUND_PLATFORM) return;
    const { day, recipients } = this.core.recipientsToday();
    const pushed = await this.ctx.storage.get<{ day: number; recipients: number }>('platformPushed');
    const delta = pushed?.day === day ? recipients - pushed.recipients : recipients;
    if (delta <= 0) return;
    try {
      const stub = this.env.OUTBOUND_PLATFORM.get(this.env.OUTBOUND_PLATFORM.idFromName('platform'));
      await stub.add(day, delta);
      await this.ctx.storage.put('platformPushed', { day, recipients });
    } catch (err) {
      console.warn('[outbound-ledger] platform push failed:', err instanceof Error ? err.message : err);
    }
  }
}

interface PlatformState {
  day: number;
  recipients: number;
  tripped: boolean;
  reason: string | null;
}

/** Customer recipients per UTC day across the platform, against the Cloudflare quota. */
export class OutboundPlatformBudget extends DurableObject<OutboundLedgerEnv> {
  private state: PlatformState | null = null;

  private today(): number {
    return Math.floor(Date.now() / 86_400_000);
  }

  private async load(): Promise<PlatformState> {
    if (!this.state) this.state = (await this.ctx.storage.get<PlatformState>('state')) ?? null;
    const day = this.today();
    if (!this.state || this.state.day !== day) this.state = { day, recipients: 0, tripped: false, reason: null };
    return this.state;
  }

  private quota(): number | null {
    const value = Number(this.env.CF_EMAIL_DAILY_QUOTA);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  async status(): Promise<{ tripped: boolean; recipients: number; quota: number | null; reason: string | null }> {
    const state = await this.load();
    return { tripped: state.tripped, recipients: state.recipients, quota: this.quota(), reason: state.reason };
  }

  async add(day: number, delta: number): Promise<void> {
    const state = await this.load();
    if (day !== state.day) return;
    state.recipients += delta;
    const quota = this.quota();
    if (!state.tripped && quota !== null && state.recipients >= quota * OUTBOUND_THRESHOLDS.platformBudgetRatio) {
      await this.tripInternal(
        state,
        `Customer mail reached ${state.recipients} of the ${quota} recipient daily quota (${Math.round(OUTBOUND_THRESHOLDS.platformBudgetRatio * 100)}%).`,
      );
    }
    await this.ctx.storage.put('state', state);
  }

  /** Cloudflare refused a send with its daily-limit error: stop first contacts until midnight UTC. */
  async trip(reason: string): Promise<void> {
    const state = await this.load();
    if (state.tripped) return;
    await this.tripInternal(state, reason);
    await this.ctx.storage.put('state', state);
  }

  private async tripInternal(state: PlatformState, reason: string): Promise<void> {
    state.tripped = true;
    state.reason = reason;
    try {
      await recordOutboundEvent(getMasterDb(this.env), { kind: 'platform' }, {
        kind: 'platform_breaker',
        toValue: 'tripped',
        reason,
        actor: 'system',
        details: { recipients: state.recipients, quota: this.quota() },
      });
    } catch (err) {
      console.error('[outbound-platform] event failed:', err instanceof Error ? err.message : err);
    }
    await openOutboundCase(this.env, {
      subject: { kind: 'platform' },
      trigger: 'platform_budget',
      severity: 'urgent',
      summary: `${reason} First-contact sends from new and standard workspaces stop until midnight UTC.`,
      metrics: { recipients: state.recipients, quota: this.quota() },
    });
  }
}
