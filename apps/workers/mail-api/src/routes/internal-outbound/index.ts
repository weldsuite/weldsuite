/**
 * Staff API for the outbound guard, called server-to-server by the admin
 * console (apps/web/admin, lib/mail-api.ts). Not behind Clerk: the console
 * sends the shared OUTBOUND_ADMIN_SECRET as `x-admin-secret` plus the signed-in
 * admin's identity (`x-admin-email`, `x-admin-user-id`), as it does for the
 * billing worker. The console writes policy changes to the master DB itself;
 * these routes reach what only the worker can: the ledgers.
 *
 *   GET  /internal/outbound/inspect?workspaceId=   usage, risk, shadow denials
 *   POST /internal/outbound/refresh  { workspaceId }   reload the policy now
 *   POST /internal/outbound/review   { workspaceId }   AI-review today's top template
 *   GET  /internal/outbound/platform                  the platform budget
 *   POST /internal/outbound/sending-events/subscribe { domains }   backfill event subscriptions
 *
 * `workspaceId` is the master workspaces.id. See docs/plans/weldmail-outbound-abuse.md.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getMasterDb, masterSchema } from '@weldsuite/worker-kit/db';
import { ledgerKeyFor, type LedgerSubject } from '@weldsuite/mail-domain/outbound';
import { subscribeSendingEvents } from '@weldsuite/worker-email';
import { error, success } from '@weldsuite/worker-kit/response';
import { adminAuth, type AdminAuthVariables } from '../../lib/admin-auth';
import type { Env } from '../../types';

type AdminVariables = AdminAuthVariables;

const app = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
app.use('*', adminAuth());

type WorkspaceSubject = Extract<LedgerSubject, { kind: 'workspace' }>;

async function workspaceSubject(env: Env, workspaceId: string): Promise<WorkspaceSubject | null> {
  const { workspaces } = masterSchema;
  const [row] = await getMasterDb(env)
    .select({ id: workspaces.id, clerkOrgId: workspaces.clerkOrgId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ? { kind: 'workspace', workspaceId: row.id, clerkOrgId: row.clerkOrgId } : null;
}

function ledger(env: Env, subject: LedgerSubject) {
  const ns = env.OUTBOUND_LEDGER!;
  return ns.get(ns.idFromName(ledgerKeyFor(subject)));
}

const workspaceBody = z.object({ workspaceId: z.string().min(1).max(255) });

app.get('/inspect', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) return error.badRequest(c, 'workspaceId is required');
  if (!c.env.OUTBOUND_LEDGER) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'No ledger binding' } }, 503);
  const subject = await workspaceSubject(c.env, workspaceId);
  if (!subject) return error.notFound(c, 'Workspace', workspaceId);
  return success(c, await ledger(c.env, subject).inspect(subject));
});

app.post('/refresh', zValidator('json', workspaceBody), async (c) => {
  if (!c.env.OUTBOUND_LEDGER) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'No ledger binding' } }, 503);
  const subject = await workspaceSubject(c.env, c.req.valid('json').workspaceId);
  if (!subject) return error.notFound(c, 'Workspace');
  await ledger(c.env, subject).refreshPolicy();
  console.log(JSON.stringify({ event: 'outbound_policy_refreshed', workspaceId: subject.workspaceId, by: c.get('adminEmail') }));
  return success(c, { ok: true });
});

app.post('/review', zValidator('json', workspaceBody), async (c) => {
  if (!c.env.OUTBOUND_LEDGER) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'No ledger binding' } }, 503);
  const subject = await workspaceSubject(c.env, c.req.valid('json').workspaceId);
  if (!subject) return error.notFound(c, 'Workspace');
  const queued = await ledger(c.env, subject).requestReview(subject);
  console.log(JSON.stringify({ event: 'outbound_review_requested', workspaceId: subject.workspaceId, by: c.get('adminEmail'), queued }));
  return success(c, { queued });
});

app.get('/platform', async (c) => {
  const ns = c.env.OUTBOUND_PLATFORM;
  if (!ns) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'No platform budget binding' } }, 503);
  return success(c, await ns.get(ns.idFromName('platform')).status());
});

app.post(
  '/sending-events/subscribe',
  zValidator('json', z.object({ domains: z.array(z.string().trim().toLowerCase().min(3).max(253)).min(1).max(100) })),
  async (c) => {
    const results: Record<string, boolean> = {};
    for (const domain of c.req.valid('json').domains) results[domain] = await subscribeSendingEvents(c.env, domain);
    return success(c, { results });
  },
);

export const internalOutboundRoutes = app;
