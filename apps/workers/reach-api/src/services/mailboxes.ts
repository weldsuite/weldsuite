/**
 * Mailbox lifecycle: create (billed, provisioned at Mailpool, entered in the
 * warmup network), update, pause / resume, delete.
 *
 * Warmup is WeldSuite's own network (docs/plans/weldreach-warmup.md): every
 * mailbox is also a row in the master pool (`reach_warmup_mailboxes`), holding
 * its logins sealed with WELDREACH_WARMUP_KEY. Create registers it, a rename,
 * pause, resume and delete keep it in step, and `services/warmup.ts` reads the
 * pool back for the health gate. Where a change touches both places the pool is
 * written first, so a retry never meets a tenant row that is ahead of the pool.
 *
 * Creating a mailbox costs money at two places, so the order is fixed and every
 * step after the first is undone if a later one fails:
 *
 *   0. config     WELDREACH_WARMUP_KEY set, else 503 before anything is paid
 *   1. checks     limit, domain active, address free (nothing to undo)
 *   2. billing    Stripe quantity +1 via billing-worker (402 without a payment method)
 *   3. slots      Mailpool subscription slot for the type
 *   4. Mailpool   create with forwardTo = reply+<inboundToken>@REACH_INBOUND_DOMAIN
 *   5. DB         tenant row (credentials sealed), warmup pool row, master routes
 *
 * A failure after step 2 rolls back: pool row, routes, tenant row, the Mailpool
 * mailbox and the billing quantity. Mailbox logins never leave this module:
 * callers get `ReachMailbox` DTOs and credential-free rows.
 */

import { and, count, eq, getTableColumns, gte, inArray, isNull, ne } from 'drizzle-orm';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { randomString } from '@weldsuite/worker-kit/random';
import {
  activePoolDomainCount,
  pausePoolMailbox,
  readPoolMailboxes,
  removePoolMailbox,
  resumePoolMailbox,
  updatePoolMailboxProfile,
  type PoolMailboxView,
} from '@weldsuite/reach-domain/warmup-pool';
import {
  WELDREACH_SENDING_DEFAULTS,
  type CreateReachMailboxInput,
  type ReachMailbox,
  type ReachMailboxStatus,
  type ReachWarmupBlocker,
  type UpdateReachMailboxInput,
  type WeldReachLimits,
} from '@weldsuite/app-api-client/schemas/reach';
import type { ReachBilling } from '../lib/billing';
import { sealMailServerCredentials } from '../lib/credentials';
import { inboundAddress } from '../lib/inbound/token';
import { imapCredentialsOf, smtpCredentialsOf } from '../lib/mailpool';
import type { MailpoolClient } from '../lib/mailpool/client';
import { isMailpoolNotFound, MailpoolError } from '../lib/mailpool/errors';
import type { MailpoolMailbox, UpdateMailpoolMailboxInput } from '../lib/mailpool/types';
import type { Env } from '../types';
import { utcDayStart, utcTomorrow } from './access';
import { releaseInbox } from './billing';
import { ReachServiceError } from './reach-errors';
import { ensureSlotAvailable } from './slots';
import { POOL_PAUSE_REASONS, registerMailboxInPool, resumeStatusFor, warmupBlockerOf } from './warmup';

export type MailboxRow = typeof schema.reachMailboxes.$inferSelect;
type DomainRow = typeof schema.reachDomains.$inferSelect;
/** A mailbox row without its sealed logins. */
export type SafeMailboxRow = ReturnType<typeof withoutCredentials>;

export function withoutCredentials(row: MailboxRow) {
  return omitSensitive('reach_mailboxes', row);
}

const mailboxColumns = omitSensitive('reach_mailboxes', getTableColumns(schema.reachMailboxes));

export interface MailboxDeps {
  env: Pick<
    Env,
    'DATABASE_ENCRYPTION_KEY' | 'DATABASE_ENCRYPTION_KEY_V2' | 'REACH_INBOUND_DOMAIN' | 'SCHEDULE_INDEX' | 'WELDREACH_WARMUP_KEY'
  >;
  db: Database;
  master: MasterDatabase;
  mailpool: MailpoolClient;
  billing: ReachBilling;
  /** Clerk org id (the tenant key). */
  clerkOrgId: string;
  /** Master `workspaces.id`. */
  masterWorkspaceId: string;
  userId: string;
  now?: () => Date;
}

const nowOf = (deps: Pick<MailboxDeps, 'now'>): Date => (deps.now ? deps.now() : new Date());

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What the warmup pool adds to a mailbox's DTO. */
export interface WarmupView {
  sent7d: number;
  spamRescues7d: number;
  blocker: ReachWarmupBlocker | null;
}

const NO_WARMUP: WarmupView = { sent7d: 0, spamRescues7d: 0, blocker: null };

export function toMailboxDto(
  row: SafeMailboxRow,
  domainName: string,
  sentToday: number,
  warmup: WarmupView = NO_WARMUP,
): ReachMailbox {
  return {
    id: row.id,
    domainId: row.domainId,
    domainName,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    signature: row.signature,
    type: row.type,
    status: row.status,
    warmupDay: row.warmupDay,
    warmupStatus: row.warmupStatus,
    warmupInboxRate: row.warmupInboxRate,
    warmupSent7d: warmup.sent7d,
    warmupSpamRescues7d: warmup.spamRescues7d,
    warmupBlocker: warmup.blocker,
    dailyCap: row.dailyCap,
    rampCurrent: row.rampCurrent,
    sentToday,
    lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
    pausedReason: row.pausedReason,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

async function sentTodayByMailbox(db: Database, mailboxIds: string[], now: Date): Promise<Map<string, number>> {
  if (mailboxIds.length === 0) return new Map();
  const rows = await db
    .select({ mailboxId: schema.reachMessages.mailboxId, value: count() })
    .from(schema.reachMessages)
    .where(
      and(
        inArray(schema.reachMessages.mailboxId, mailboxIds),
        eq(schema.reachMessages.direction, 'out'),
        eq(schema.reachMessages.status, 'sent'),
        gte(schema.reachMessages.sentAt, utcDayStart(now)),
      ),
    )
    .groupBy(schema.reachMessages.mailboxId);
  return new Map(rows.map((r) => [r.mailboxId, r.value]));
}

/**
 * Where a request reads the warmup pool: the master DB, opened lazily so a
 * list with no mailboxes (or a master outage) costs nothing.
 */
export interface WarmupSource {
  /** Clerk org id (the tenant key). */
  clerkOrgId: string;
  master: () => MasterDatabase;
}

export interface MailboxReadDeps {
  db: Database;
  warmup: WarmupSource;
}

/** The read deps of a request that already has its write deps. */
export function readDepsOf(deps: Pick<MailboxDeps, 'db' | 'master' | 'clerkOrgId'>): MailboxReadDeps {
  return { db: deps.db, warmup: { clerkOrgId: deps.clerkOrgId, master: () => deps.master } };
}

/**
 * The pool rows of the workspace plus the pool's domain count: at most two
 * master queries per request (the count only when a mailbox is warming).
 * Best effort: warmup numbers are decoration, so a master failure shows zeros
 * rather than failing the mailbox list.
 */
async function readWarmupViews(
  source: WarmupSource,
  rows: Array<Pick<MailboxRow, 'status'>>,
): Promise<{ pool: Map<string, PoolMailboxView>; poolDomains: number | null }> {
  const none = { pool: new Map<string, PoolMailboxView>(), poolDomains: null };
  if (rows.length === 0) return none;
  try {
    const master = source.master();
    const views = await readPoolMailboxes(master, source.clerkOrgId);
    const poolDomains = rows.some((r) => r.status === 'warming') ? await activePoolDomainCount(master) : null;
    return { pool: new Map(views.map((v) => [v.tenantMailboxId, v])), poolDomains };
  } catch (err) {
    console.warn('[reach-mailboxes] warmup pool unavailable:', err);
    return none;
  }
}

function warmupViewOf(
  row: SafeMailboxRow,
  views: { pool: Map<string, PoolMailboxView>; poolDomains: number | null },
): WarmupView {
  const pool = views.pool.get(row.id);
  return {
    sent7d: pool?.stats?.sent7d ?? 0,
    spamRescues7d: pool?.stats?.spamRescues7d ?? 0,
    blocker: warmupBlockerOf(row, pool, views.poolDomains),
  };
}

export interface ListMailboxesFilter {
  domainId?: string;
  status?: ReachMailboxStatus;
}

export async function listMailboxes(
  { db, warmup }: MailboxReadDeps,
  filter: ListMailboxesFilter = {},
  now: Date = new Date(),
): Promise<ReachMailbox[]> {
  const where =
    filter.status === 'deleted'
      ? [eq(schema.reachMailboxes.status, 'deleted')]
      : [
          ne(schema.reachMailboxes.status, 'deleted'),
          isNull(schema.reachMailboxes.deletedAt),
          ...(filter.status ? [eq(schema.reachMailboxes.status, filter.status)] : []),
        ];
  if (filter.domainId) where.push(eq(schema.reachMailboxes.domainId, filter.domainId));

  const rows = await db
    .select({ ...mailboxColumns, domainName: schema.reachDomains.name })
    .from(schema.reachMailboxes)
    .leftJoin(schema.reachDomains, eq(schema.reachMailboxes.domainId, schema.reachDomains.id))
    .where(and(...where))
    .orderBy(schema.reachMailboxes.createdAt);

  const sent = await sentTodayByMailbox(db, rows.map((r) => r.id), now);
  const views = await readWarmupViews(warmup, rows);
  return rows.map(({ domainName, ...row }) => toMailboxDto(row, domainName ?? '', sent.get(row.id) ?? 0, warmupViewOf(row, views)));
}

export async function getMailboxDto(
  { db, warmup }: MailboxReadDeps,
  id: string,
  now: Date = new Date(),
): Promise<ReachMailbox | null> {
  const [row] = await db
    .select({ ...mailboxColumns, domainName: schema.reachDomains.name })
    .from(schema.reachMailboxes)
    .leftJoin(schema.reachDomains, eq(schema.reachMailboxes.domainId, schema.reachDomains.id))
    .where(and(eq(schema.reachMailboxes.id, id), ne(schema.reachMailboxes.status, 'deleted')))
    .limit(1);
  if (!row) return null;
  const { domainName, ...mailbox } = row;
  const sent = await sentTodayByMailbox(db, [id], now);
  const views = await readWarmupViews(warmup, [mailbox]);
  return toMailboxDto(mailbox, domainName ?? '', sent.get(id) ?? 0, warmupViewOf(mailbox, views));
}

async function requireMailbox(db: Database, id: string): Promise<MailboxRow> {
  const [row] = await db
    .select()
    .from(schema.reachMailboxes)
    .where(and(eq(schema.reachMailboxes.id, id), ne(schema.reachMailboxes.status, 'deleted')))
    .limit(1);
  if (!row) throw new ReachServiceError(404, 'NOT_FOUND', `Mailbox with ID '${id}' not found`);
  return row;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateMailboxOptions {
  limits: WeldReachLimits;
  /** `reach_settings.defaultMailboxDailyCap`. */
  defaultDailyCap: number;
  /** `workspace_app_access.billing_status` (billing-worker keeps it current). */
  billingStatus?: 'none' | 'active' | 'past_due' | 'canceled';
  /** `reach_settings.defaultTimezone`: the hours the mailbox "works" in for warmup. Read from the settings when omitted. */
  timezone?: string;
}

/** Step 1 of create: everything that can be refused before a cent is spent. */
async function checkCanCreate(
  deps: MailboxDeps,
  input: CreateReachMailboxInput,
  options: CreateMailboxOptions,
): Promise<{ domain: DomainRow; mailpoolDomainId: string; email: string }> {
  const { db } = deps;
  const [domain] = await db.select().from(schema.reachDomains).where(eq(schema.reachDomains.id, input.domainId)).limit(1);
  if (!domain) throw new ReachServiceError(404, 'DOMAIN_NOT_FOUND', `Domain with ID '${input.domainId}' not found`);
  if (domain.status !== 'active' || !domain.mailpoolDomainId) {
    throw new ReachServiceError(409, 'DOMAIN_NOT_ACTIVE', 'The domain is not active yet. Wait until it is connected.');
  }

  const [{ value: existing } = { value: 0 }] = await db
    .select({ value: count() })
    .from(schema.reachMailboxes)
    .where(and(ne(schema.reachMailboxes.status, 'deleted'), isNull(schema.reachMailboxes.deletedAt)));
  if (existing >= options.limits.maxMailboxes) {
    throw new ReachServiceError(403, 'MAILBOX_LIMIT_REACHED', 'The mailbox limit for this workspace is reached.', {
      limit: options.limits.maxMailboxes,
      current: existing,
    });
  }
  // Stripe cancelled the inbox subscription (non-payment) while mailboxes still
  // exist. A new inbox would start a fresh subscription billing only itself, so
  // the existing ones would go unbilled: billing has to be sorted out first.
  if (options.billingStatus === 'canceled' && existing > 0) {
    throw new ReachServiceError(
      402,
      'BILLING_CANCELED',
      'The inbox subscription was cancelled. Contact support to restart billing before adding mailboxes.',
    );
  }

  const email = `${input.localPart}@${domain.name}`;
  const [taken] = await db.select({ id: schema.reachMailboxes.id }).from(schema.reachMailboxes).where(eq(schema.reachMailboxes.email, email)).limit(1);
  if (taken) throw new ReachServiceError(409, 'MAILBOX_EXISTS', `${email} already exists. Choose another name.`);

  return { domain, mailpoolDomainId: domain.mailpoolDomainId, email };
}

export async function createMailbox(
  deps: MailboxDeps,
  input: CreateReachMailboxInput,
  options: CreateMailboxOptions,
): Promise<MailboxRow> {
  const now = nowOf(deps);

  const inboundDomain = deps.env.REACH_INBOUND_DOMAIN;
  if (!inboundDomain) {
    throw new ReachServiceError(503, 'INBOUND_NOT_CONFIGURED', 'Reply routing is not configured for this environment.');
  }
  // The pool seals logins with this key: without it nothing can warm, so refuse before anything is paid.
  if (!deps.env.WELDREACH_WARMUP_KEY) {
    throw new ReachServiceError(503, 'WARMUP_NOT_CONFIGURED', 'The warmup network is not configured for this environment.');
  }

  // 1. Checks. Nothing to undo yet.
  const { domain, mailpoolDomainId, email } = await checkCanCreate(deps, input, options);

  const mailboxId = generateId('rmbx');
  const inboundToken = randomString(24, 'abcdefghijklmnopqrstuvwxyz');

  // 2. Billing. A 402 or a billing failure stops here, with nothing to undo.
  await deps.billing.adjustInboxes(1, mailboxId);

  const undo: CreateUndo = { mailpoolMailboxId: null, tenantRow: false, pool: false, routes: false };

  try {
    // 3 + 4. Mailpool: a slot, then the mailbox.
    await ensureSlotAvailable(deps.mailpool, input.type);
    const created = await createAtMailpool(deps, mailpoolDomainId, {
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      type: input.type,
      signature: input.signature,
      inboundToken,
      inboundDomain,
    });
    undo.mailpoolMailboxId = String(created.id);

    if (created.status === 'inactive') {
      throw new ReachServiceError(
        502,
        'UPSTREAM_ERROR',
        created.error?.message ?? 'The mailbox provider could not activate the mailbox.',
      );
    }

    // 5. Our own records. Warming needs both logins: an active mailbox without them waits as provisioning.
    const smtp = smtpCredentialsOf(created);
    const imap = imapCredentialsOf(created);
    const logins = created.status === 'active' && smtp && imap ? { smtp, imap } : null;
    const row = await insertMailboxRow(deps, {
      id: mailboxId,
      domainId: domain.id,
      mailpoolMailboxId: undo.mailpoolMailboxId,
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      signature: input.signature ?? null,
      type: input.type,
      // Mailpool may still be creating it (Google); the daily pass and the webhook finish the job.
      status: logins ? 'warming' : 'provisioning',
      warmupStatus: logins ? 'waiting' : null,
      smtpCredentials: smtp ? await sealMailServerCredentials(deps.env, smtp) : null,
      imapCredentials: imap ? await sealMailServerCredentials(deps.env, imap) : null,
      inboundToken,
      warmupStartedAt: logins ? now : null,
      dailyCap: options.defaultDailyCap,
      rampCurrent: Math.min(WELDREACH_SENDING_DEFAULTS.rampStart, options.defaultDailyCap),
      createdBy: deps.userId,
    });
    undo.tenantRow = true;

    if (logins) {
      // Before the routes, so a failure of the routes still has the pool row to take back.
      undo.pool = true;
      await registerMailboxInPool(deps, row, logins, options.timezone);
    }

    await insertRoutes(deps, { mailboxId, mailpoolMailboxId: undo.mailpoolMailboxId, inboundToken, type: input.type });
    undo.routes = true;

    await markWorkspaceDue(deps.env.SCHEDULE_INDEX, 'reach_warmup', deps.clerkOrgId, utcTomorrow(now));
    return row;
  } catch (err) {
    await rollbackCreate(deps, { mailboxId, inboundToken, email, mailpoolDomainId, undo });
    throw err;
  }
}

/** The tenant row. A unique violation on the address means somebody else just took it. */
async function insertMailboxRow(deps: MailboxDeps, values: typeof schema.reachMailboxes.$inferInsert): Promise<MailboxRow> {
  const [row] = await deps.db
    .insert(schema.reachMailboxes)
    .values(values)
    .returning()
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        throw new ReachServiceError(409, 'MAILBOX_EXISTS', `${values.email} already exists. Choose another name.`);
      }
      throw err;
    });
  if (!row) throw new Error('reach_mailboxes insert returned no row');
  return row;
}

/** The two master routes: Mailpool's webhooks find the mailbox by its Mailpool id, forwarded replies by their token. */
async function insertRoutes(
  deps: MailboxDeps,
  route: { mailboxId: string; mailpoolMailboxId: string; inboundToken: string; type: CreateReachMailboxInput['type'] },
): Promise<void> {
  const common = {
    workspaceId: deps.masterWorkspaceId,
    clerkOrgId: deps.clerkOrgId,
    tenantEntityId: route.mailboxId,
    mailboxType: route.type,
    status: 'active' as const,
  };
  await deps.master.insert(masterSchema.reachRoutes).values([
    { id: generateId('rrt'), kind: 'mailpool_mailbox', externalId: route.mailpoolMailboxId, ...common },
    { id: generateId('rrt'), kind: 'inbound_token', externalId: route.inboundToken, ...common },
  ]);
}

async function createAtMailpool(
  deps: MailboxDeps,
  mailpoolDomainId: string,
  input: {
    email: string;
    firstName: string;
    lastName: string;
    type: CreateReachMailboxInput['type'];
    signature?: string;
    inboundToken: string;
    inboundDomain: string;
  },
): Promise<MailpoolMailbox> {
  try {
    return await deps.mailpool.createMailbox({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      type: input.type,
      signature: input.signature,
      forwardTo: inboundAddress(input.inboundToken, input.inboundDomain),
    });
  } catch (err) {
    // No (or an unclear) answer may still have created it: look for it so the rollback can delete it.
    if (err instanceof MailpoolError && (err.status === 0 || err.status >= 500)) {
      const stray = await findStrayMailbox(deps.mailpool, mailpoolDomainId, input.email);
      if (stray) return stray;
    }
    throw err;
  }
}

/** A mailbox Mailpool created although the create call failed; null when there is none or Mailpool cannot say. */
async function findStrayMailbox(mailpool: MailpoolClient, mailpoolDomainId: string, email: string): Promise<MailpoolMailbox | null> {
  try {
    const { data } = await mailpool.listMailboxes({ domainId: mailpoolDomainId, limit: 100, offset: 0 });
    return data.find((m) => m.email.toLowerCase() === email.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/** What a failed create has to take back. */
interface CreateUndo {
  mailpoolMailboxId: string | null;
  tenantRow: boolean;
  pool: boolean;
  routes: boolean;
}

async function rollbackCreate(
  deps: MailboxDeps,
  ctx: {
    mailboxId: string;
    inboundToken: string;
    email: string;
    mailpoolDomainId: string;
    undo: CreateUndo;
  },
): Promise<void> {
  const { undo } = ctx;
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[reach-mailboxes] rollback of ${ctx.email}: ${what} failed:`, err);
    }
  };

  if (undo.pool) {
    await attempt('warmup pool', () => removePoolMailbox(deps.master, deps.clerkOrgId, ctx.mailboxId));
  }
  if (undo.routes || undo.tenantRow) {
    await attempt('master routes', () =>
      deps.master
        .delete(masterSchema.reachRoutes)
        .where(
          and(
            eq(masterSchema.reachRoutes.workspaceId, deps.masterWorkspaceId),
            eq(masterSchema.reachRoutes.tenantEntityId, ctx.mailboxId),
            inArray(masterSchema.reachRoutes.kind, ['mailpool_mailbox', 'inbound_token']),
          ),
        ),
    );
  }
  if (undo.tenantRow) {
    await attempt('tenant row', () => deps.db.delete(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, ctx.mailboxId)));
  }
  if (undo.mailpoolMailboxId) {
    const id = undo.mailpoolMailboxId;
    await attempt('Mailpool mailbox', () => deps.mailpool.deleteMailbox(id));
  }
  await releaseInbox(deps.billing, ctx.mailboxId);
}

// ---------------------------------------------------------------------------
// Update, pause, resume
// ---------------------------------------------------------------------------

/** The part of an update Mailpool has to hear about: only what actually changed. */
function remoteChangesOf(input: UpdateReachMailboxInput, row: MailboxRow): UpdateMailpoolMailboxInput {
  const remote: UpdateMailpoolMailboxInput = {};
  if (input.firstName !== undefined && input.firstName !== row.firstName) remote.firstName = input.firstName;
  if (input.lastName !== undefined && input.lastName !== row.lastName) remote.lastName = input.lastName;
  if (input.signature !== undefined && (input.signature ?? '') !== (row.signature ?? '')) remote.signature = input.signature ?? '';
  return remote;
}

export async function updateMailbox(deps: MailboxDeps, id: string, input: UpdateReachMailboxInput): Promise<MailboxRow> {
  const row = await requireMailbox(deps.db, id);
  if (row.status === 'deleting') throw new ReachServiceError(409, 'MAILBOX_DELETING', 'The mailbox is being deleted.');

  const remote = remoteChangesOf(input, row);

  // Mailpool first: if it refuses, nothing changed here either. Then the pool, so a retry is a plain repeat.
  if (Object.keys(remote).length > 0 && row.mailpoolMailboxId) {
    await deps.mailpool.updateMailbox(row.mailpoolMailboxId, remote);
  }
  if (remote.firstName !== undefined || remote.lastName !== undefined) {
    await updatePoolMailboxProfile(deps.master, deps.clerkOrgId, id, { firstName: remote.firstName, lastName: remote.lastName });
  }

  const patch: Partial<typeof schema.reachMailboxes.$inferInsert> = { updatedAt: nowOf(deps) };
  if (input.firstName !== undefined) patch.firstName = input.firstName;
  if (input.lastName !== undefined) patch.lastName = input.lastName;
  if (input.signature !== undefined) patch.signature = input.signature ?? null;
  if (input.dailyCap !== undefined) {
    patch.dailyCap = input.dailyCap;
    if (row.rampCurrent > input.dailyCap) patch.rampCurrent = input.dailyCap;
  }

  const [updated] = await deps.db.update(schema.reachMailboxes).set(patch).where(eq(schema.reachMailboxes.id, id)).returning();
  return updated ?? row;
}

/** What pause and resume need: the tenant, and the pool in master. */
export type MailboxPoolDeps = Pick<MailboxDeps, 'db' | 'master' | 'clerkOrgId'>;

/** Stop campaigns using this mailbox, and its warmup (it neither sends nor receives warmup mail). */
export async function pauseMailbox(deps: MailboxPoolDeps, id: string, now: Date = new Date()): Promise<MailboxRow> {
  const { db } = deps;
  const row = await requireMailbox(db, id);
  if (row.status === 'paused') return row;
  if (row.status !== 'warming' && row.status !== 'active') {
    throw new ReachServiceError(409, 'MAILBOX_NOT_PAUSABLE', `A ${row.status} mailbox cannot be paused.`);
  }
  // Pool first: if the tenant write fails the retry still pauses (the pool pause is idempotent).
  await pausePoolMailbox(deps.master, deps.clerkOrgId, id, POOL_PAUSE_REASONS.user);
  const [updated] = await db
    .update(schema.reachMailboxes)
    .set({ status: 'paused', pausedReason: 'user', updatedAt: now })
    .where(eq(schema.reachMailboxes.id, id))
    .returning();
  return updated ?? row;
}

export async function resumeMailbox(deps: MailboxPoolDeps, id: string, now: Date = new Date()): Promise<MailboxRow> {
  const { db } = deps;
  const row = await requireMailbox(db, id);
  if (row.status === 'warming' || row.status === 'active') return row;
  if (row.status !== 'paused') {
    throw new ReachServiceError(409, 'MAILBOX_NOT_RESUMABLE', `A ${row.status} mailbox cannot be resumed.`);
  }

  const [domain] = await db.select().from(schema.reachDomains).where(eq(schema.reachDomains.id, row.domainId)).limit(1);
  if (!domain || domain.status !== 'active') {
    throw new ReachServiceError(409, 'DOMAIN_NOT_ACTIVE', 'The domain of this mailbox is not active.');
  }

  // Pool first, for the same reason as in pauseMailbox.
  await resumePoolMailbox(deps.master, deps.clerkOrgId, id);
  const [updated] = await db
    .update(schema.reachMailboxes)
    .set({ status: resumeStatusFor(row), pausedReason: null, updatedAt: now })
    .where(eq(schema.reachMailboxes.id, id))
    .returning();
  return updated ?? row;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete at Mailpool (scheduled deletion), take the mailbox out of the warmup
 * pool, close the routes, take it out of campaigns, wipe its stored logins and
 * finally give the inbox back to Stripe. The row stays (status `deleted`) for the message history.
 *
 * Built to be re-run: a delete that stopped half way leaves the mailbox in
 * `deleting` and calling it again finishes the job. Every step before the last
 * is idempotent (Mailpool answering 404 counts as done), and the Stripe
 * decrement is last, so a retry can never take the same inbox off twice.
 */
export async function deleteMailbox(deps: MailboxDeps, id: string): Promise<MailboxRow> {
  const { db } = deps;
  const now = nowOf(deps);
  const row = await requireMailbox(db, id);

  // Claim it, so a campaign pick sees it as going away.
  if (row.status !== 'deleting') {
    await db.update(schema.reachMailboxes).set({ status: 'deleting', updatedAt: now }).where(eq(schema.reachMailboxes.id, id));
  }

  try {
    if (row.mailpoolMailboxId) {
      try {
        await deps.mailpool.deleteMailbox(row.mailpoolMailboxId);
      } catch (err) {
        if (!isMailpoolNotFound(err)) throw err; // already gone at Mailpool: fine
      }
    }
  } catch (err) {
    await db.update(schema.reachMailboxes).set({ status: row.status, updatedAt: now }).where(eq(schema.reachMailboxes.id, id));
    throw err;
  }

  // Out of the warmup network: its scheduled warmup mail is cancelled and the sealed logins are overwritten.
  await removePoolMailbox(deps.master, deps.clerkOrgId, id);

  await deps.master
    .update(masterSchema.reachRoutes)
    .set({ status: 'deleted', updatedAt: now })
    .where(
      and(
        eq(masterSchema.reachRoutes.workspaceId, deps.masterWorkspaceId),
        eq(masterSchema.reachRoutes.tenantEntityId, id),
        inArray(masterSchema.reachRoutes.kind, ['mailpool_mailbox', 'inbound_token']),
      ),
    );

  await db.delete(schema.reachCampaignMailboxes).where(eq(schema.reachCampaignMailboxes.mailboxId, id));
  // Follow-ups pick a new sender at their next send.
  await db
    .update(schema.reachEnrollments)
    .set({ mailboxId: null, updatedAt: now })
    .where(
      and(
        eq(schema.reachEnrollments.mailboxId, id),
        inArray(schema.reachEnrollments.status, ['queued', 'active', 'paused']),
      ),
    );

  const [deleted] = await db
    .update(schema.reachMailboxes)
    .set({
      status: 'deleted',
      deletedAt: now,
      smtpCredentials: null,
      imapCredentials: null,
      pausedReason: null,
      updatedAt: now,
    })
    .where(eq(schema.reachMailboxes.id, id))
    .returning();

  await releaseInbox(deps.billing, id);
  return deleted ?? row;
}

