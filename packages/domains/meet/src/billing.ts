/**
 * WeldMeet AI billing: transcript and summary, both priced per MEETING MINUTE.
 *
 * Why this is not `@weldsuite/core-domain/ai-billing`: that one is token
 * priced (`creditsForUsage(modelId, usage)`), so it cannot charge "credits per
 * meeting minute". This talks to the prepaid wallet in `@weldsuite/credits`
 * directly and copies ai-billing's settlement rule: the work already happened
 * on Cloudflare's side by the time the result arrives, so a charge the wallet
 * cannot cover is recorded as debt (negative adjustment) instead of being
 * dropped.
 *
 * Gate + charge:
 *  - {@link assertMeetingAiCredits} BEFORE enabling or starting paid work. The
 *    balance must cover at least one minute of the selected items.
 *  - {@link chargeMeetingAi} AFTER the result is stored, idempotent per
 *    session/kind so webhook replays and workflow retries charge once.
 *
 * Pricing: master `system_settings` row `weldmeet.ai_pricing` (category
 * `billing`, JSON `{ transcriptionCreditsPerMinute, summaryCreditsPerMinute }`),
 * edited from the admin console. Read through a 60 s KV cache plus a per-isolate
 * memo; defaults come from `SERVICE_CREDIT_RATES` when the row is absent.
 */

import { eq } from 'drizzle-orm';
import {
  SERVICE_CREDIT_RATES,
  checkCredits,
  getBalance,
  consumeCredits,
  grantCredits,
  resolveInternalWorkspaceId,
} from '@weldsuite/credits';
import { getMasterDb, masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { DbEnv } from '@weldsuite/worker-kit/env';

// ============================================================================
// Pricing
// ============================================================================

export const WELDMEET_AI_PRICING_KEY = 'weldmeet.ai_pricing';
export const WELDMEET_AI_PRICING_KV_KEY = 'weldmeet-ai-pricing';
/** KV cache lifetime. Also the longest an admin price change takes to reach meet-api. */
export const PRICING_CACHE_TTL_SECONDS = 60;

export interface MeetingAiPricing {
  /** Credits per meeting minute for a transcript. */
  transcriptionCreditsPerMinute: number;
  /** Credits per meeting minute for an AI summary. */
  summaryCreditsPerMinute: number;
}

export type MeetingAiKind = 'transcription' | 'summary';

export function defaultMeetingAiPricing(): MeetingAiPricing {
  return {
    transcriptionCreditsPerMinute: SERVICE_CREDIT_RATES.meetingTranscriptionPerMinute,
    summaryCreditsPerMinute: SERVICE_CREDIT_RATES.meetingSummaryPerMinute,
  };
}

/** A rate is a positive number with at most 2 decimals and at most 1000. */
function validRate(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value <= 0 || value > 1000) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** Validate a stored value; every invalid or missing field falls back to its default. */
export function parseMeetingAiPricing(value: unknown): MeetingAiPricing {
  const defaults = defaultMeetingAiPricing();
  if (!value || typeof value !== 'object') return defaults;
  const v = value as Record<string, unknown>;
  return {
    transcriptionCreditsPerMinute: validRate(v.transcriptionCreditsPerMinute)
      ? v.transcriptionCreditsPerMinute
      : defaults.transcriptionCreditsPerMinute,
    summaryCreditsPerMinute: validRate(v.summaryCreditsPerMinute)
      ? v.summaryCreditsPerMinute
      : defaults.summaryCreditsPerMinute,
  };
}

let memo: { at: number; pricing: MeetingAiPricing } | null = null;

/** Drop the per-isolate memo (tests, and callers that just changed the setting). */
export function resetMeetingAiPricingMemo(): void {
  memo = null;
}

async function loadPricingFromDb(env: Pick<DbEnv, 'DATABASE_URL_MASTER'>): Promise<MeetingAiPricing> {
  const masterDb = getMasterDb(env);
  const [row] = await masterDb
    .select({ value: masterSchema.systemSettings.value })
    .from(masterSchema.systemSettings)
    .where(eq(masterSchema.systemSettings.key, WELDMEET_AI_PRICING_KEY))
    .limit(1);
  return parseMeetingAiPricing(row?.value);
}

/**
 * Current WeldMeet AI price list. Memo (per isolate) -> KV (shared, 60 s) ->
 * master DB. A lookup failure serves the defaults rather than blocking meetings.
 */
export async function getMeetingAiPricing(
  env: Pick<DbEnv, 'DATABASE_URL_MASTER' | 'WORKSPACE_CACHE'>,
): Promise<MeetingAiPricing> {
  const now = Date.now();
  if (memo && now - memo.at < PRICING_CACHE_TTL_SECONDS * 1000) return memo.pricing;

  try {
    const cached = await env.WORKSPACE_CACHE.get(WELDMEET_AI_PRICING_KV_KEY, 'json');
    if (cached) {
      const pricing = parseMeetingAiPricing(cached);
      memo = { at: now, pricing };
      return pricing;
    }
  } catch {
    /* KV miss/outage: fall through to the DB */
  }

  try {
    const pricing = await loadPricingFromDb(env);
    memo = { at: now, pricing };
    try {
      await env.WORKSPACE_CACHE.put(WELDMEET_AI_PRICING_KV_KEY, JSON.stringify(pricing), {
        expirationTtl: PRICING_CACHE_TTL_SECONDS,
      });
    } catch {
      /* cache write is best effort */
    }
    return pricing;
  } catch (err) {
    console.warn(
      '[meet-billing] pricing lookup failed, using defaults:',
      err instanceof Error ? err.message : err,
    );
    return defaultMeetingAiPricing();
  }
}

// ============================================================================
// Metering + gate
// ============================================================================

export interface MeetingMetering {
  masterDb: MasterDatabase;
  /** Internal workspace id (`workspace_credits.workspace_id`), NOT the Clerk org id. */
  internalWsId: string;
  userId: string;
}

/** The wallet cannot be located, so paid work must not start. Map to 503. */
export class MeetingBillingUnavailableError extends Error {
  constructor(message = 'Credit metering is unavailable for this workspace') {
    super(message);
    this.name = 'MeetingBillingUnavailableError';
  }
}

/** The balance does not cover the minimum for the selected items. Map to 402. */
export class InsufficientMeetingCreditsError extends Error {
  constructor(
    public readonly currentBalance: number,
    public readonly required: number,
    public readonly shortfall: number,
  ) {
    super('Insufficient credits');
    this.name = 'InsufficientMeetingCreditsError';
  }
}

/**
 * Resolve the wallet for a Clerk org. Unlike ai-billing this FAILS CLOSED: the
 * old transcription workflow looked the wallet up by Clerk org id, found
 * nothing and silently charged nothing. Throws
 * {@link MeetingBillingUnavailableError} when the workspace has no master row.
 */
export async function resolveMeetingMetering(
  env: Pick<DbEnv, 'DATABASE_URL_MASTER'>,
  orgId: string,
  userId: string,
  masterDb: MasterDatabase = getMasterDb(env),
): Promise<MeetingMetering> {
  const internalWsId = await resolveInternalWorkspaceId(masterDb, orgId);
  if (!internalWsId) throw new MeetingBillingUnavailableError(`No billing workspace for org ${orgId}`);
  return { masterDb, internalWsId, userId };
}

/** Current prepaid balance (can be negative after a late settlement), for the UI estimate. */
export async function getMeetingBalance(metering: MeetingMetering): Promise<number> {
  return (await getBalance(metering.masterDb, metering.internalWsId)).currentBalance;
}

/** Credits for `minutes` of `rate`: always a positive integer for any real duration. */
export function creditsForMinutes(minutes: number, ratePerMinute: number): number {
  if (!(minutes > 0) || !(ratePerMinute > 0)) return 0;
  return Math.ceil(minutes * ratePerMinute - 1e-9);
}

/** Whole meeting minutes, rounded up: 61 s is 2 minutes. */
export function billableMinutes(durationSeconds: number | null | undefined): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}

/** Smallest balance that lets the selected items start: one minute of each. */
export function minimumBalanceFor(
  pricing: MeetingAiPricing,
  selected: { transcription?: boolean; summary?: boolean },
): number {
  const perMinute =
    (selected.transcription ? pricing.transcriptionCreditsPerMinute : 0) +
    (selected.summary ? pricing.summaryCreditsPerMinute : 0);
  return Math.max(1, creditsForMinutes(1, perMinute));
}

/**
 * Hard gate: throws {@link InsufficientMeetingCreditsError} when the wallet
 * cannot cover one minute of the selected items. Advisory (the charge itself
 * settles negative), so it only needs to stop a workspace with an empty wallet.
 */
export async function assertMeetingAiCredits(
  metering: MeetingMetering,
  pricing: MeetingAiPricing,
  selected: { transcription?: boolean; summary?: boolean },
): Promise<void> {
  const required = minimumBalanceFor(pricing, selected);
  const check = await checkCredits(metering.masterDb, metering.internalWsId, required);
  if (!check.available) {
    throw new InsufficientMeetingCreditsError(check.currentBalance, check.required, check.shortfall);
  }
}

// ============================================================================
// Charge
// ============================================================================

const SERVICE_TYPE = {
  transcription: 'meeting_transcription',
  summary: 'meeting_summary',
} as const;

/** Stable key: one charge per session and kind (plus a run discriminator where re-runs are legitimate). */
export function meetingAiIdempotencyKey(kind: MeetingAiKind, sessionId: string, runId?: string): string {
  return `meet-${kind}:${sessionId}${runId ? `:${runId}` : ''}`;
}

export interface ChargeMeetingAiParams {
  kind: MeetingAiKind;
  sessionId: string;
  minutes: number;
  ratePerMinute: number;
  /** Where the result came from, for the ledger metadata. */
  source: 'rtk' | 'whisper' | 'workers_ai';
  /** Distinguishes legitimate re-runs (a second Whisper pass after a delete). */
  runId?: string;
}

export interface ChargeMeetingAiResult {
  credits: number;
  /** True when a retry found the original charge. */
  duplicate: boolean;
  /** True when the wallet could not cover it and the charge became debt. */
  settledNegative: boolean;
}

/**
 * Charge a finished transcript or summary. Consumes from the wallet; when the
 * balance is short it records the cost as a negative adjustment instead. Both
 * writes are idempotent on the key, so a workflow retry never double charges.
 */
export async function chargeMeetingAi(
  metering: MeetingMetering,
  params: ChargeMeetingAiParams,
): Promise<ChargeMeetingAiResult> {
  const credits = creditsForMinutes(params.minutes, params.ratePerMinute);
  if (credits <= 0) return { credits: 0, duplicate: false, settledNegative: false };

  const idempotencyKey = meetingAiIdempotencyKey(params.kind, params.sessionId, params.runId);
  const serviceType = SERVICE_TYPE[params.kind];
  const meta = {
    minutes: params.minutes,
    ratePerMinute: params.ratePerMinute,
    source: params.source,
  };
  const description = `WeldMeet ${params.kind}: ${params.minutes} min`;

  const settle = await consumeCredits(metering.masterDb, {
    workspaceId: metering.internalWsId,
    amount: credits,
    serviceType,
    idempotencyKey,
    referenceId: params.sessionId,
    referenceType: 'meeting_session',
    description,
    metadata: meta,
    userId: metering.userId,
  });
  if (settle.ok) return { credits, duplicate: settle.duplicate, settledNegative: false };

  // The work is done and the wallet is short: record the debt.
  const debt = await grantCredits(metering.masterDb, {
    workspaceId: metering.internalWsId,
    amount: -credits,
    type: 'adjustment',
    serviceType,
    idempotencyKey: `${idempotencyKey}:settle`,
    referenceId: params.sessionId,
    referenceType: 'meeting_session',
    description: `${description}: settled into negative balance`,
    metadata: { ...meta, forcedSettlement: true },
    userId: metering.userId,
  });
  return { credits, duplicate: debt.duplicate, settledNegative: true };
}
