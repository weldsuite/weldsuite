/**
 * Usage settlement (ADR PANEL-007): what panel-api does with the counts the
 * collector's PanelUsage objects send (`POST /internal/panel/usage/settle`,
 * see ../internal.ts).
 *
 *  1. Store the month's totals in the master `panel_usage_monthly` row. They
 *     only ever grow (`greatest`), so a late or repeated report changes nothing.
 *  2. Charge every overage block the totals have reached that is not charged
 *     yet to the credit wallet, one `consumeCredits` per block with the key
 *     `weldpanel:<workspace>:<month>:events|recordings:<n>`. A retry, a second
 *     isolate or a crash between the charge and the row update charges once.
 *  3. Work out the quota state: a block the wallet could not pay means
 *     `replay_blocked` (recordings stop at once); when it is an events block
 *     and events are past the allowance plus the 10% grace (counted from the
 *     allowance), `events_blocked`. Settling again after a top-up retries the
 *     unpaid blocks, so the block lifts by itself.
 *  4. For the current month, write the state to KV (`panel:quota:<workspace>`,
 *     deleted for `ok`: missing means ok) for the collector, and email the
 *     owners once per threshold (./usage-notices).
 */

import { and, eq, sql } from 'drizzle-orm';
import { consumeCredits } from '@weldsuite/credits';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  PANEL_EVENT_BLOCK,
  PANEL_RECORDING_BLOCK,
  eventGraceLimit,
  overageBlocks,
  type PanelPlanLimits,
} from '@weldsuite/panel-domain/plans';
import { quotaKvKey, type PanelQuotaState } from '@weldsuite/panel-domain/registry';
import type { PanelPricing } from '@weldsuite/panel-domain/pricing';
import { getPanelPricing } from './pricing';
import { loadWorkspacePlan, type WorkspacePlan } from './workspace-plan';
import { planUsageNotice, type UsageNotice } from './usage-notices';
import { applyReplayTier } from './project-registry';

const { panelUsageMonthly } = masterSchema;

export type PanelUsageMonth = typeof panelUsageMonthly.$inferSelect;

export { loadWorkspacePlan, type WorkspacePlan };

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface SettlementDeps {
  masterDb: AnyMasterDatabase;
  kv: Pick<KVNamespace, 'get' | 'put' | 'delete'>;
  /** Emails the owners; best effort, the caller swallows its own failures. */
  notify?: (notice: UsageNotice) => Promise<void>;
  now?: Date;
}

export interface SettlementInput {
  /** `workspaces.id`. */
  workspaceId: string;
  /** `YYYY-MM`, UTC. */
  month: string;
  events: number;
  recordings: number;
}

export interface SettlementResult {
  month: string;
  workspace: WorkspacePlan;
  usage: PanelUsageMonth;
  quota: PanelQuotaState;
  pricing: PanelPricing;
}

type Meter = 'events' | 'recordings';

/**
 * Charges blocks `already + 1 … needed` of one meter, stopping at the first the
 * wallet cannot pay. Returns the number of blocks now charged and the credits
 * this call accounts for (a block the ledger already holds counts: the row had
 * fallen behind it).
 */
async function chargeBlocks(
  deps: SettlementDeps,
  input: SettlementInput,
  meter: Meter,
  needed: number,
  already: number,
  creditsPerBlock: number,
): Promise<{ charged: number; credits: number }> {
  let charged = already;
  let credits = 0;
  while (charged < needed) {
    const block = charged + 1;
    const result = await consumeCredits(deps.masterDb, {
      workspaceId: input.workspaceId,
      amount: creditsPerBlock,
      serviceType: meter === 'events' ? 'panel_events' : 'panel_recordings',
      idempotencyKey: `weldpanel:${input.workspaceId}:${input.month}:${meter}:${block}`,
      referenceId: `${input.workspaceId}:${input.month}`,
      referenceType: 'panel_usage',
      description: `WeldPanel ${meter} beyond the plan allowance (${input.month}, block ${block})`,
      metadata: { month: input.month, meter, block },
    });
    if (!result.ok) break;
    charged = block;
    credits += creditsPerBlock;
  }
  return { charged, credits };
}

/** Quota state for a month's totals and what was paid. Pure. */
export function quotaFor(limits: PanelPlanLimits, usage: Pick<PanelUsageMonth, 'events' | 'recordings' | 'eventBlocksCharged' | 'recordingBlocksCharged'>): PanelQuotaState {
  const eventsUnpaid = overageBlocks(usage.events, limits.events, PANEL_EVENT_BLOCK) > usage.eventBlocksCharged;
  const recordingsUnpaid = overageBlocks(usage.recordings, limits.recordings, PANEL_RECORDING_BLOCK) > usage.recordingBlocksCharged;
  if (eventsUnpaid && usage.events > eventGraceLimit(limits.events)) return 'events_blocked';
  if (eventsUnpaid || recordingsUnpaid) return 'replay_blocked';
  return 'ok';
}

export async function writeQuotaState(kv: Pick<KVNamespace, 'put' | 'delete'>, workspaceId: string, quota: PanelQuotaState): Promise<void> {
  if (quota === 'ok') await kv.delete(quotaKvKey(workspaceId));
  else await kv.put(quotaKvKey(workspaceId), quota);
}

/** The UTC month a moment falls in, `YYYY-MM`. */
export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Start of the month after `month`, ISO. */
export function nextMonthStart(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString();
}

/** Returns null when the workspace does not exist (nothing is stored or charged). */
export async function settleUsage(deps: SettlementDeps, input: SettlementInput): Promise<SettlementResult | null> {
  const now = deps.now ?? new Date();
  const workspace = await loadWorkspacePlan(deps.masterDb, input.workspaceId);
  if (!workspace) return null;
  const pricing = await getPanelPricing(deps.masterDb, deps.kv);

  const [stored] = await deps.masterDb
    .insert(panelUsageMonthly)
    .values({ id: generateId('pnu'), workspaceId: input.workspaceId, month: input.month, events: input.events, recordings: input.recordings })
    .onConflictDoUpdate({
      target: [panelUsageMonthly.workspaceId, panelUsageMonthly.month],
      set: {
        events: sql`greatest(${panelUsageMonthly.events}, ${input.events})`,
        recordings: sql`greatest(${panelUsageMonthly.recordings}, ${input.recordings})`,
        updatedAt: now,
      },
    })
    .returning();
  if (!stored) throw new Error('panel_usage_monthly upsert returned no row');

  const eventsNeeded = overageBlocks(stored.events, workspace.limits.events, PANEL_EVENT_BLOCK);
  const recordingsNeeded = overageBlocks(stored.recordings, workspace.limits.recordings, PANEL_RECORDING_BLOCK);

  let usage = stored;
  if (eventsNeeded > stored.eventBlocksCharged || recordingsNeeded > stored.recordingBlocksCharged) {
    const events = await chargeBlocks(deps, input, 'events', eventsNeeded, stored.eventBlocksCharged, pricing.eventsCreditsPer10k);
    const recordings = await chargeBlocks(deps, input, 'recordings', recordingsNeeded, stored.recordingBlocksCharged, pricing.recordingsCreditsPer100);
    // `greatest` keeps two settlements running at once from undoing each other; credits are the
    // row's value at the start plus what this call charged, so both writing the same block agree.
    const [updated] = await deps.masterDb
      .update(panelUsageMonthly)
      .set({
        eventBlocksCharged: sql`greatest(${panelUsageMonthly.eventBlocksCharged}, ${events.charged})`,
        recordingBlocksCharged: sql`greatest(${panelUsageMonthly.recordingBlocksCharged}, ${recordings.charged})`,
        eventCreditsCharged: sql`greatest(${panelUsageMonthly.eventCreditsCharged}, ${stored.eventCreditsCharged + events.credits})`,
        recordingCreditsCharged: sql`greatest(${panelUsageMonthly.recordingCreditsCharged}, ${stored.recordingCreditsCharged + recordings.credits})`,
        updatedAt: now,
      })
      .where(eq(panelUsageMonthly.id, stored.id))
      .returning();
    usage = updated ?? stored;
  }

  const quota = quotaFor(workspace.limits, usage);

  // Only the current month decides what the collector does; a late report for an old month charges but stays out of KV.
  if (input.month === monthOf(now)) {
    await writeQuotaState(deps.kv, input.workspaceId, quota);
    try {
      await applyReplayTier({ masterDb: deps.masterDb, kv: deps.kv }, input.workspaceId, workspace.limits.replayTier);
    } catch (error) {
      console.error(`[panel-api] replay tier refresh for workspace ${input.workspaceId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (deps.notify) {
      try {
        const notice = await planUsageNotice(deps.masterDb, workspace, usage, quota);
        if (notice) await deps.notify(notice);
      } catch (error) {
        console.error(`[panel-api] usage notice for workspace ${input.workspaceId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { month: input.month, workspace, usage, quota, pricing };
}

/** The stored row of a workspace's month, if any. */
export async function usageRow(masterDb: AnyMasterDatabase, workspaceId: string, month: string): Promise<PanelUsageMonth | undefined> {
  const [row] = await masterDb
    .select()
    .from(panelUsageMonthly)
    .where(and(eq(panelUsageMonthly.workspaceId, workspaceId), eq(panelUsageMonthly.month, month)))
    .limit(1);
  return row;
}
