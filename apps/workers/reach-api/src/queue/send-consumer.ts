/**
 * `reach-send` queue consumer: one message = one workspace with outreach due.
 *
 * Per message, in this order (docs/plans/weldreach.md, "Sending engine"):
 *   1. access: read the master DB (never the KV cache) so a suspension, a
 *      cancelled subscription or a past-due one beyond its grace stops sending
 *      within a minute;
 *   2. the Flagship kill switch `weldreach-sending` (default on);
 *   3. only then open the tenant DB and run one tick (`services/send-tick.ts`);
 *   4. store when the workspace next has work, in the D1 due index.
 *
 * An unexpected error retries the message (the claim and the message rows make
 * a retry safe: nothing is sent twice).
 */

import { getFlags, type FlagsContext } from '@weldsuite/feature-flags/server';
import { resolveWeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import { readSendDueRow, settleSendDue } from '../cron/send-sweep';
import { maySend, openTenantDb, readReachAccess } from '../lib/tenant';
import { runSendTick, type TickDeps, type TickResult } from '../services/send-tick';
import type { Env, ReachSendMessage } from '../types';
import type { Database } from '@weldsuite/worker-kit';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import type { SmtpSocketFactory } from '@weldsuite/smtp';

export const KILL_SWITCH_FLAG = 'weldreach-sending' as const;
/** Look again this long after a workspace was found not allowed to send (a suspension can be lifted). */
const NOT_ALLOWED_RECHECK_MS = 60 * 60_000;
const KILL_SWITCH_RECHECK_MS = 5 * 60_000;
const RETRY_DELAY_SECONDS = 60;

/** Evaluate the global kill switch outside a request. Defaults to on when Flagship is not bound. */
export async function isSendingEnabled(env: Env, clerkOrgId: string): Promise<boolean> {
  const context: FlagsContext = {
    env,
    get: ((key: 'userId' | 'workspaceId' | 'orgId') => (key === 'userId' ? 'system' : clerkOrgId)) as FlagsContext['get'],
  };
  const flags = await getFlags(context);
  return flags.isOn(KILL_SWITCH_FLAG);
}

export type SendMessageOutcome =
  | { status: 'ticked'; tick: TickResult }
  | { status: 'skipped'; reason: string };

export interface ProcessDeps {
  /** Tests inject a ready database instead of opening the tenant. */
  openDb?: (env: Env, clerkOrgId: string) => Promise<Database>;
  readAccess?: (env: Env, clerkOrgId: string) => Promise<AppAccess>;
  connect?: SmtpSocketFactory;
  now?: () => Date;
}

export async function processSendMessage(env: Env, body: ReachSendMessage, deps: ProcessDeps = {}): Promise<SendMessageOutcome> {
  const { clerkOrgId } = body;
  const now = (deps.now ?? (() => new Date()))();
  const d1 = env.SCHEDULE_INDEX;
  const dueRow = await readSendDueRow(d1, clerkOrgId);

  const access = await (deps.readAccess ?? readReachAccess)(env, clerkOrgId);
  if (access.workspaceId === null) {
    // No such workspace any more: nothing will ever be due here again.
    await settleSendDue(d1, clerkOrgId, dueRow, null);
    return { status: 'skipped', reason: 'unknown_workspace' };
  }
  const allowed = maySend(access, now);
  if (!allowed.ok) {
    await settleSendDue(d1, clerkOrgId, dueRow, new Date(now.getTime() + NOT_ALLOWED_RECHECK_MS));
    return { status: 'skipped', reason: allowed.reason };
  }
  if (!(await isSendingEnabled(env, clerkOrgId))) {
    await settleSendDue(d1, clerkOrgId, dueRow, new Date(now.getTime() + KILL_SWITCH_RECHECK_MS));
    return { status: 'skipped', reason: 'kill_switch' };
  }

  const db = await (deps.openDb ?? openTenantDb)(env, clerkOrgId);
  const tickDeps: TickDeps = {
    env,
    db,
    clerkOrgId,
    limits: resolveWeldReachLimits(access.limits),
    connect: deps.connect,
    now: deps.now,
  };
  const tick = await runSendTick(tickDeps);
  await settleSendDue(d1, clerkOrgId, dueRow, tick.nextDueAt);
  if (tick.claimed > 0) {
    console.log(
      `[reach-send] ${clerkOrgId} claimed=${tick.claimed} sent=${tick.sent} bounced=${tick.bounced} failed=${tick.failed} deferred=${tick.deferred}`,
    );
  }
  return { status: 'ticked', tick };
}

export async function handleSendQueue(batch: MessageBatch<ReachSendMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processSendMessage(env, message.body);
      message.ack();
    } catch (err) {
      console.error(`[reach-send] ${message.body.clerkOrgId} failed, will retry:`, err);
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}
