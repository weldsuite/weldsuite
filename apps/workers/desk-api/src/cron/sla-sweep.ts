/**
 * WeldDesk SLA sweep — Cloudflare cron handler (every minute).
 *
 * Announces SLA warnings and breaches on inbox conversations: an internal
 * `sla_warning` / `sla_breached` event on the timeline, a notification to the
 * assignee (or the whole team when unassigned), a `desk_conversation` entity
 * event for workflows and agents, and a live update of the inbox.
 *
 * It never wakes idle tenant DBs (ADR DATA-008): timing lives in the
 * SCHEDULE_INDEX D1 `workspace_due_index` (kind `desk_sla`). Every desk write
 * re-derives the conversation's clocks (refreshDeskSla, called by
 * appendDeskMessage) and the worker that made it marks the workspace due at
 * the earliest `slaCheckAt` (lib/sla-due.ts here, and the same call in
 * helpdesk-widget-api, mail-inbound-worker and call-api). Each tick reads only
 * D1, opens the workspaces that are due, re-derives their due clocks with
 * `acknowledge`, announces what came due and stores when the workspace is next
 * due (or drops the row). Clocks only exist since this index does, so the
 * one-time seed has nothing to add.
 */

import { eq } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { sendDeskSlaNotification } from '@weldsuite/notifications';
import {
  appendDeskMessage,
  type DeskConversation,
} from '@weldsuite/db/lib/desk';
import {
  listDueDeskSlaConversations,
  nextDeskSlaCheckAt,
  refreshDeskSla,
  releaseDeskSlaAlert,
  type DeskSlaAlert,
} from '@weldsuite/db/lib/desk-sla';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../types';

type TenantDb = Variables['tenantDb'];

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const SLA_SWEEP_CRONS = ['* * * * *'] as const;

export function isSlaSweepCron(cron: string): boolean {
  return (SLA_SWEEP_CRONS as readonly string[]).includes(cron);
}

/** KV flag for the due index's one-time seed (nothing to seed: see above). */
export const SLA_INDEX_SEED_KEY = 'desk:sla-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 10 * 60_000;
/** A conversation whose clocks fail to refresh, or whose alert fails to post, is looked at again after this. */
const CONVERSATION_RETRY_MS = 30 * 60_000;
/** Conversations per workspace per tick; the rest stay due for the next tick. */
const CONVERSATIONS_PER_TICK = 100;

const EVENT_TYPE = { warning: 'sla_warning', breach: 'sla_breached' } as const;

/**
 * Post one warning or breach. Only the timeline event can throw; notification,
 * entity event and live update are best-effort after it.
 */
async function announce(
  env: Env,
  db: TenantDb,
  orgId: string,
  conversation: DeskConversation,
  alert: DeskSlaAlert,
): Promise<void> {
  const eventType = EVENT_TYPE[alert.type];
  const { conversation: updated, message } = await appendDeskMessage(db, {
    generateId,
    conversationId: conversation.id,
    kind: 'event',
    authorType: 'system',
    metadata: { eventType, metric: alert.metric, dueAt: alert.dueAt?.toISOString() ?? null },
  });

  const jobs: Promise<unknown>[] = [
    publishEntityEventRaw({
      env,
      workspaceId: orgId,
      userId: 'system',
      entityType: 'desk_conversation',
      action: eventType,
      entityId: updated.id,
      data: { ...updated, slaAlertMetric: alert.metric } as unknown as Record<string, unknown>,
    }),
    sendDeskSlaNotification({
      db,
      env,
      workspaceId: orgId,
      type: alert.type,
      metric: alert.metric,
      conversationId: updated.id,
      assigneeId: updated.assigneeId,
      subject: updated.title || updated.name || updated.email,
      reference: `#${updated.conversationNumber}`,
      dueAt: alert.dueAt,
    }),
  ];
  if (env.REALTIME) {
    const rt = new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET });
    // The event is internal: the inbox hub only, never the visitor's conversation room.
    jobs.push(rt.publish(orgId, 'desk_conversation', 'updated', updated, 'system'));
    jobs.push(rt.publish(orgId, 'desk_message', 'created', message, 'system'));
  }
  for (const result of await Promise.allSettled(jobs)) {
    if (result.status === 'rejected') console.error('[DeskSla] announcing failed:', result.reason);
  }
}

/**
 * Re-derive one workspace's due clocks, announce what came due; returns how
 * many alerts went out. `announceAlert` is replaceable for tests.
 */
export async function sweepWorkspaceSla(
  env: Env,
  db: TenantDb,
  orgId: string,
  now: Date,
  announceAlert: typeof announce = announce,
): Promise<number> {
  let announced = 0;
  const retryAt = new Date(now.getTime() + CONVERSATION_RETRY_MS);
  const ids = await listDueDeskSlaConversations(db, now, CONVERSATIONS_PER_TICK);
  for (const id of ids) {
    try {
      const result = await refreshDeskSla(db, id, { generateId, now, acknowledge: true });
      if (!result.conversation) continue;
      for (const alert of result.alerts) {
        try {
          await announceAlert(env, db, orgId, result.conversation, alert);
          announced += 1;
        } catch (err) {
          // refreshDeskSla already marked it announced: undo that, or the retry
          // finds nothing to say and the warning or breach is lost.
          console.error(`[DeskSla] announcing ${alert.type} on ${id} in ${orgId} failed:`, err);
          await releaseDeskSlaAlert(db, alert, retryAt);
        }
      }
    } catch (err) {
      console.error(`[DeskSla] conversation ${id} in ${orgId} failed:`, err);
      // Don't let one broken conversation keep its workspace due every tick.
      await db
        .update(schema.deskSlaClocks)
        .set({ nextCheckAt: retryAt })
        .where(eq(schema.deskSlaClocks.conversationId, id))
        .catch((retryErr: unknown) => console.warn(`[DeskSla] could not back off ${id}:`, retryErr));
    }
  }
  return announced;
}

export async function runSlaSweep(
  env: Env,
  now: Date = new Date(),
): Promise<DueIndexSweepResult & { announced: number }> {
  let announced = 0;
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'desk_sla',
    label: '[DeskSla]',
    seed: { key: SLA_INDEX_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId, at) => {
      const db = (await getTenantDbForWorkspace(env, orgId)) as unknown as TenantDb;
      announced += await sweepWorkspaceSla(env, db, orgId, at);
      return nextDeskSlaCheckAt(db);
    },
  });

  if (result.due > 0 || result.failed > 0) {
    console.log(
      `[DeskSla] due=${result.due} processed=${result.processed} announced=${announced} failed=${result.failed}`,
    );
  }
  return { ...result, announced };
}
