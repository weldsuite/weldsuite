/**
 * WeldForms sweeps: Cloudflare Cron Handler (every 15 minutes).
 *
 * - `forms_reminders`: automatic invitation reminders that are due (never after
 *   the form's close date, never once completed);
 * - `forms_digest`: the daily response digest, due at 08:00 UTC once a form with
 *   daily subscribers got a response.
 *
 * Neither wakes idle tenant DBs (ADR DATA-008): timing lives in the SCHEDULE_INDEX
 * D1 `workspace_due_index`. Inviting, reminding and submitting mark the workspace
 * due; each tick reads only D1, opens the workspaces that are due, does their
 * work and stores when they are next due (or drops the row). There is nothing to
 * seed: both kinds are born with the first invitation or response.
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getMasterDb, getTenantDbForWorkspace, getWorkspaceForOrg } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import type { WorkspaceCtx } from '../services/context';
import { sendDueDigests } from '../services/digest';
import { sendDueReminders } from '../services/invitations';
import type { Env } from '../types';

/** The cron expression that runs the sweeps; keep in step with wrangler.toml. */
export const FORMS_SWEEP_CRONS = ['*/15 * * * *'] as const;

export function isFormsSweepCron(cron: string): boolean {
  return (FORMS_SWEEP_CRONS as readonly string[]).includes(cron);
}

/** KV flags of the (empty) one-time seeds. */
export const REMINDERS_SEED_KEY = 'forms:reminders-index:seed:v1';
export const DIGEST_SEED_KEY = 'forms:digest-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 30 * 60_000;

async function open(env: Env, orgId: string): Promise<WorkspaceCtx> {
  const [db, workspace] = await Promise.all([getTenantDbForWorkspace(env, orgId), getWorkspaceForOrg(env, orgId)]);
  return { env, db, master: getMasterDb(env), workspaceId: workspace.id, clerkOrgId: orgId };
}

export async function runRemindersSweep(env: Env, now: Date = new Date()): Promise<DueIndexSweepResult & { reminded: number }> {
  let reminded = 0;
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'forms_reminders',
    label: '[FormsReminders]',
    seed: { key: REMINDERS_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId, at) => {
      const ctx = await open(env, orgId);
      const swept = await sendDueReminders(ctx, at);
      reminded += swept.reminded.length;
      await Promise.all(
        swept.reminded.map((row) =>
          publishEntityEventRaw({
            env,
            workspaceId: orgId,
            userId: 'system',
            entityType: 'form_invitation',
            action: 'sent',
            entityId: row.id,
            data: { id: row.id, formId: row.formId, email: row.email, personId: row.personId, reminder: true },
          }),
        ),
      );
      return swept.next;
    },
  });
  if (result.due > 0 || result.failed > 0) console.log(`[FormsReminders] due=${result.due} processed=${result.processed} reminded=${reminded} failed=${result.failed}`);
  return { ...result, reminded };
}

export async function runDigestSweep(env: Env, now: Date = new Date()): Promise<DueIndexSweepResult & { sent: number }> {
  let sent = 0;
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'forms_digest',
    label: '[FormsDigest]',
    seed: { key: DIGEST_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId, at) => {
      sent += await sendDueDigests(await open(env, orgId), at);
      // Nothing is pending after the digests: the next response marks the workspace due again.
      return null;
    },
  });
  if (result.due > 0 || result.failed > 0) console.log(`[FormsDigest] due=${result.due} processed=${result.processed} sent=${sent} failed=${result.failed}`);
  return { ...result, sent };
}

export async function runFormsSweeps(env: Env, now: Date = new Date()) {
  const [reminders, digests] = await Promise.all([runRemindersSweep(env, now), runDigestSweep(env, now)]);
  return { reminders, digests };
}
