/**
 * Staff API that drives the mailbox store's backfill, catch-up, full parity
 * and reverse sync (design doc §4, §9 task C4), called server-to-server by
 * the admin console — the same secret-plus-identity pattern as
 * `routes/internal-outbound` (not Clerk), via the extracted
 * `lib/admin-auth.ts`.
 *
 *   POST /internal/mail-store/backfill     { workspaceId, accountId, force?, source? }
 *   GET  /internal/mail-store/backfill     ?workspaceId=&accountId=
 *   POST /internal/mail-store/parity       { workspaceId, accountId, repair?, cursor?, maxRows? }
 *   POST /internal/mail-store/reverse-sync { workspaceId, accountId, since, cursor?, maxRows? }
 *   POST /internal/mail-store/rebuild      { workspaceId, accountId }
 *   GET  /internal/mail-store/status       ?workspaceId=&accountId=
 *   GET  /internal/mail-store/status/all   ?workspaceId=
 *
 * `workspaceId` is `workspaces.id`; `accountId` is `mail_accounts.id`. Both
 * are validated against the master DB (workspace exists) and the tenant DB
 * (the account belongs to that workspace) before any Durable Object is
 * addressed — a typo'd id would otherwise silently spin up a fresh, empty
 * mailbox object under a nonsense name.
 *
 * `parity` and `reverse-sync` are internally bounded, resumable RPCs on the
 * object (`./parity.ts`, `./reverse-sync.ts` in `@weldsuite/mail-domain`,
 * task C4's own files) — this route loops them to completion (or
 * `MAX_ADMIN_ITERATIONS`, for a mailbox too large to finish in one HTTP
 * request) so the admin console gets one consolidated report per call,
 * merging each round's `missing`/`extra`/`different`/counts.
 *
 * No tenant data (addresses, subjects, body text) ever reaches a log line
 * here — only ids and counts. The responses themselves may carry mailbox
 * state (that's the point of this API), but nothing is written to
 * `console.*` beyond `{workspaceId, accountId, adminEmail, counts}`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema } from '@weldsuite/worker-kit/db';
import { mailboxStubFor } from '@weldsuite/mail-domain/store/object';
import type { MailboxAdminRpc, MailboxStoreRpc, MailboxStoreStatus, ParityReport, ReverseSyncReport } from '@weldsuite/mail-domain/mailbox-object';
import type { MailboxRef } from '@weldsuite/mail-domain/store/types';
import { error, success } from '@weldsuite/worker-kit/response';
import { adminAuth, type AdminAuthVariables } from '../../lib/admin-auth';
import type { Env } from '../../types';

const { mailAccounts } = schema;

const app = new Hono<{ Bindings: Env; Variables: AdminAuthVariables }>();
app.use('*', adminAuth());

// ---------------------------------------------------------------------------
// Workspace / account resolution
// ---------------------------------------------------------------------------

async function resolveWorkspace(env: Env, workspaceId: string): Promise<{ id: string; clerkOrgId: string | null } | null> {
  const { workspaces } = masterSchema;
  const [row] = await getMasterDb(env)
    .select({ id: workspaces.id, clerkOrgId: workspaces.clerkOrgId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ?? null;
}

type RefResolution = { ok: true; ref: MailboxRef } | { ok: false; resource: 'Workspace' | 'Mail account'; id: string };

/**
 * Resolves and validates `{workspaceId, accountId}` into a bindable
 * `MailboxRef`: the workspace must exist (master DB) and the account must
 * belong to its tenant DB — otherwise a typo'd id would silently address a
 * fresh, empty Durable Object under a nonsense name instead of 404ing.
 * Returns a plain discriminated result (not a `Response`) so callers use
 * their own real Hono `Context` for `error.notFound`.
 */
async function resolveRef(env: Env, workspaceId: string, accountId: string): Promise<RefResolution> {
  const workspace = await resolveWorkspace(env, workspaceId);
  if (!workspace) return { ok: false, resource: 'Workspace', id: workspaceId };
  const db = await getTenantDbForWorkspace(env, workspace.id);
  const [account] = await db.select({ id: mailAccounts.id }).from(mailAccounts).where(eq(mailAccounts.id, accountId)).limit(1);
  if (!account) return { ok: false, resource: 'Mail account', id: accountId };
  return { ok: true, ref: { workspaceId: workspace.id, accountId: account.id, clerkOrgId: workspace.clerkOrgId } };
}

function stubFor(env: Env, ref: MailboxRef): MailboxStoreRpc & MailboxAdminRpc {
  return mailboxStubFor(env, ref) as unknown as MailboxStoreRpc & MailboxAdminRpc;
}

function notConfigured(c: Context<{ Bindings: Env; Variables: AdminAuthVariables }>) {
  return c.json({ error: { code: 'NOT_CONFIGURED', message: 'No MAILBOX_STORE binding' } }, 503);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const workspaceAccountBody = z.object({
  workspaceId: z.string().min(1).max(255),
  accountId: z.string().min(1).max(255),
});

const workspaceAccountQuery = z.object({
  workspaceId: z.string().min(1).max(255),
  accountId: z.string().min(1).max(255),
});

const backfillBody = workspaceAccountBody.extend({
  force: z.boolean().optional(),
  source: z.string().min(1).max(100).optional(),
});

const MAX_ROWS_CAP = 50_000;

const parityBody = workspaceAccountBody.extend({
  repair: z.boolean().optional(),
  cursor: z.string().min(1).max(255).nullish(),
  maxRows: z.number().int().positive().max(MAX_ROWS_CAP).optional(),
});

const reverseSyncBody = workspaceAccountBody.extend({
  since: z.number().int().nonnegative(),
  cursor: z.object({ updatedAt: z.number().int().nonnegative(), id: z.string().min(1).max(255) }).nullish(),
  maxRows: z.number().int().positive().max(MAX_ROWS_CAP).optional(),
});

/** A mailbox too large to finish in one HTTP request needs more than this many rounds — the response reports `done: false` and the last `cursor` for the console to resume with. */
const MAX_ADMIN_ITERATIONS = 50;

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

app.post('/backfill', zValidator('json', backfillBody), async (c) => {
  if (!c.env.MAILBOX_STORE) return notConfigured(c);
  const body = c.req.valid('json');
  const resolved = await resolveRef(c.env, body.workspaceId, body.accountId);
  if (!resolved.ok) return error.notFound(c, resolved.resource, resolved.id);
  const state = await stubFor(c.env, resolved.ref).startBackfill(resolved.ref, { force: body.force, source: body.source ?? `admin:${c.get('adminEmail')}` });
  console.log(JSON.stringify({ event: 'mailbox_backfill_started', workspaceId: resolved.ref.workspaceId, accountId: resolved.ref.accountId, by: c.get('adminEmail'), state: state.state }));
  return success(c, state);
});

app.get('/backfill', zValidator('query', workspaceAccountQuery), async (c) => {
  if (!c.env.MAILBOX_STORE) return notConfigured(c);
  const query = c.req.valid('query');
  const resolved = await resolveRef(c.env, query.workspaceId, query.accountId);
  if (!resolved.ok) return error.notFound(c, resolved.resource, resolved.id);
  return success(c, await stubFor(c.env, resolved.ref).backfillStatus(resolved.ref));
});

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

async function runParityToCompletion(stub: MailboxAdminRpc, ref: MailboxRef, body: z.infer<typeof parityBody>): Promise<ParityReport & { iterations: number }> {
  const missing = new Set<string>();
  const extra = new Set<string>();
  const different = new Map<string, ParityReport['different'][number]>();
  let scanned = 0;
  let cursor = body.cursor ?? null;
  let iterations = 0;
  let last: ParityReport;
  do {
    // eslint-disable-next-line no-await-in-loop -- each round's cursor depends on the previous round's result
    last = await stub.runParity(ref, { repair: body.repair, cursor, maxRows: body.maxRows });
    iterations++;
    scanned += last.scanned;
    for (const id of last.missing) missing.add(id);
    for (const id of last.extra) extra.add(id);
    for (const d of last.different) different.set(d.id, d);
    cursor = last.cursor;
  } while (!last.done && iterations < MAX_ADMIN_ITERATIONS);
  return { ...last, scanned, missing: [...missing], extra: [...extra], different: [...different.values()], iterations };
}

app.post('/parity', zValidator('json', parityBody), async (c) => {
  if (!c.env.MAILBOX_STORE) return notConfigured(c);
  const body = c.req.valid('json');
  const resolved = await resolveRef(c.env, body.workspaceId, body.accountId);
  if (!resolved.ok) return error.notFound(c, resolved.resource, resolved.id);
  const report = await runParityToCompletion(stubFor(c.env, resolved.ref), resolved.ref, body);
  console.log(
    JSON.stringify({
      event: 'mailbox_parity_run',
      workspaceId: resolved.ref.workspaceId,
      accountId: resolved.ref.accountId,
      by: c.get('adminEmail'),
      scanned: report.scanned,
      missing: report.missing.length,
      extra: report.extra.length,
      different: report.different.length,
      repaired: report.repaired,
      done: report.done,
    }),
  );
  return success(c, report);
});

// ---------------------------------------------------------------------------
// Reverse sync
// ---------------------------------------------------------------------------

async function runReverseSyncToCompletion(stub: MailboxAdminRpc, ref: MailboxRef, body: z.infer<typeof reverseSyncBody>): Promise<ReverseSyncReport & { iterations: number }> {
  let cursor = body.cursor ?? null;
  let iterations = 0;
  let messagesInserted = 0;
  let messagesUpdated = 0;
  let draftsSynced = 0;
  let subscriptionsSynced = 0;
  let last: ReverseSyncReport;
  do {
    // eslint-disable-next-line no-await-in-loop -- each round's cursor depends on the previous round's result
    last = await stub.reverseSync(ref, { since: body.since, cursor, maxRows: body.maxRows });
    iterations++;
    messagesInserted += last.counts.messagesInserted;
    messagesUpdated += last.counts.messagesUpdated;
    draftsSynced += last.counts.draftsSynced;
    subscriptionsSynced += last.counts.subscriptionsSynced;
    cursor = last.cursor;
  } while (!last.done && iterations < MAX_ADMIN_ITERATIONS);
  return { ...last, counts: { messagesInserted, messagesUpdated, draftsSynced, subscriptionsSynced }, iterations };
}

app.post('/reverse-sync', zValidator('json', reverseSyncBody), async (c) => {
  if (!c.env.MAILBOX_STORE) return notConfigured(c);
  const body = c.req.valid('json');
  const resolved = await resolveRef(c.env, body.workspaceId, body.accountId);
  if (!resolved.ok) return error.notFound(c, resolved.resource, resolved.id);
  const report = await runReverseSyncToCompletion(stubFor(c.env, resolved.ref), resolved.ref, body);
  console.log(
    JSON.stringify({
      event: 'mailbox_reverse_sync_run',
      workspaceId: resolved.ref.workspaceId,
      accountId: resolved.ref.accountId,
      by: c.get('adminEmail'),
      since: body.since,
      ...report.counts,
      done: report.done,
    }),
  );
  return success(c, report);
});

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

app.post('/rebuild', zValidator('json', workspaceAccountBody), async (c) => {
  if (!c.env.MAILBOX_STORE) return notConfigured(c);
  const body = c.req.valid('json');
  const resolved = await resolveRef(c.env, body.workspaceId, body.accountId);
  if (!resolved.ok) return error.notFound(c, resolved.resource, resolved.id);
  const state = await stubFor(c.env, resolved.ref).rebuildMailbox(resolved.ref);
  console.log(JSON.stringify({ event: 'mailbox_rebuilt', workspaceId: resolved.ref.workspaceId, accountId: resolved.ref.accountId, by: c.get('adminEmail') }));
  return success(c, state);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

app.get('/status', zValidator('query', workspaceAccountQuery), async (c) => {
  if (!c.env.MAILBOX_STORE) return notConfigured(c);
  const query = c.req.valid('query');
  const resolved = await resolveRef(c.env, query.workspaceId, query.accountId);
  if (!resolved.ok) return error.notFound(c, resolved.resource, resolved.id);
  return success(c, await stubFor(c.env, resolved.ref).status(resolved.ref));
});

app.get('/status/all', zValidator('query', z.object({ workspaceId: z.string().min(1).max(255) })), async (c) => {
  if (!c.env.MAILBOX_STORE) return notConfigured(c);
  const { workspaceId } = c.req.valid('query');
  const workspace = await resolveWorkspace(c.env, workspaceId);
  if (!workspace) return error.notFound(c, 'Workspace', workspaceId);
  const db = await getTenantDbForWorkspace(c.env, workspace.id);
  const accounts = await db.select({ id: mailAccounts.id }).from(mailAccounts);
  const results: Array<{ accountId: string; status: MailboxStoreStatus } | { accountId: string; error: string }> = [];
  for (const account of accounts) {
    const ref: MailboxRef = { workspaceId: workspace.id, accountId: account.id, clerkOrgId: workspace.clerkOrgId };
    try {
      // eslint-disable-next-line no-await-in-loop -- one Durable Object round trip per mailbox; a workspace has at most a handful of accounts
      const status = await stubFor(c.env, ref).status(ref);
      results.push({ accountId: account.id, status });
    } catch (err) {
      results.push({ accountId: account.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return success(c, results);
});

export const internalMailStoreRoutes = app;
