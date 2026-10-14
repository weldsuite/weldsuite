/**
 * WeldReach warmup pool (master `reach_warmup_mailboxes`): what reach-api
 * writes when a mailbox is created, renamed, paused, resumed or deleted, and
 * what it reads back for the health gate, the UI and the inbound filter. The
 * warmup worker (apps/workers/reach-warmup-worker) runs the network itself.
 *
 * Logins are sealed with WELDREACH_WARMUP_KEY, a key separate from the tenant
 * DATABASE_ENCRYPTION_KEY, so the warmup worker never needs tenant secrets.
 * See docs/plans/weldreach-warmup.md.
 */

import { and, countDistinct, eq, inArray, ne, or } from 'drizzle-orm';
import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { ReachMailServerCredentials } from '@weldsuite/db/schema';
import { masterSchema, type AnyMasterDatabase, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { WARMUP_MIN_DAYS, domainOf } from './warmup';

const pool = masterSchema.reachWarmupMailboxes;
const messages = masterSchema.reachWarmupMessages;

type PoolRow = typeof pool.$inferSelect;
export type ReachWarmupStatus = PoolRow['status'];

export interface WarmupKeyEnv {
  /** 64 hex characters (32 bytes); a worker secret on reach-api and reach-warmup-worker. */
  WELDREACH_WARMUP_KEY?: string;
}

export class WarmupKeyMissingError extends Error {
  constructor() {
    super('WELDREACH_WARMUP_KEY is not configured');
    this.name = 'WarmupKeyMissingError';
  }
}

function warmupKeyring(env: WarmupKeyEnv): EncryptionKeyring {
  if (!env.WELDREACH_WARMUP_KEY) throw new WarmupKeyMissingError();
  return { v2: env.WELDREACH_WARMUP_KEY };
}

export async function sealWarmupCredentials(env: WarmupKeyEnv, credentials: ReachMailServerCredentials): Promise<string> {
  return encryptField(JSON.stringify(credentials), warmupKeyring(env));
}

/** null when the blob cannot be opened or is malformed. */
export async function openWarmupCredentials(env: WarmupKeyEnv, blob: string): Promise<ReachMailServerCredentials | null> {
  try {
    const parsed = JSON.parse(await decryptField(blob, warmupKeyring(env))) as Partial<ReachMailServerCredentials>;
    if (
      typeof parsed.host !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.username !== 'string' ||
      typeof parsed.password !== 'string'
    ) {
      return null;
    }
    return { host: parsed.host, port: parsed.port, tls: parsed.tls !== false, username: parsed.username, password: parsed.password };
  } catch (err) {
    if (err instanceof WarmupKeyMissingError) throw err;
    return null;
  }
}

/** The pool row of one tenant mailbox. */
function byTenantMailbox(clerkOrgId: string, tenantMailboxId: string) {
  return and(eq(pool.clerkOrgId, clerkOrgId), eq(pool.tenantMailboxId, tenantMailboxId));
}

/** The status a mailbox returns to after a pause: where its warmup had got to. */
export function unpausedStatus(row: Pick<PoolRow, 'startedAt' | 'rampDay'>): ReachWarmupStatus {
  if (!row.startedAt) return 'waiting';
  return row.rampDay >= WARMUP_MIN_DAYS ? 'maintaining' : 'warming';
}

export interface RegisterPoolMailboxInput {
  /** Master `workspaces.id`. */
  workspaceId: string;
  clerkOrgId: string;
  tenantMailboxId: string;
  email: string;
  firstName: string;
  lastName: string;
  mailboxType: string;
  timezone?: string;
  smtp: ReachMailServerCredentials;
  imap: ReachMailServerCredentials;
}

/**
 * Add a mailbox to the pool (status `waiting`; the warmup worker starts it once
 * the pool spans enough domains). Re-registering the same tenant mailbox
 * replaces its logins and profile and brings a removed row back.
 */
export async function registerPoolMailbox(
  master: MasterDatabase,
  env: WarmupKeyEnv,
  input: RegisterPoolMailboxInput,
): Promise<{ id: string }> {
  const [smtpCredentials, imapCredentials] = await Promise.all([
    sealWarmupCredentials(env, input.smtp),
    sealWarmupCredentials(env, input.imap),
  ]);
  const email = input.email.trim().toLowerCase();
  const now = new Date();
  const values = {
    workspaceId: input.workspaceId,
    clerkOrgId: input.clerkOrgId,
    tenantMailboxId: input.tenantMailboxId,
    email,
    domain: domainOf(email),
    mailboxType: input.mailboxType,
    firstName: input.firstName,
    lastName: input.lastName,
    timezone: input.timezone ?? 'Europe/Amsterdam',
    smtpCredentials,
    imapCredentials,
    updatedAt: now,
  };

  const [existing] = await master
    .select({ id: pool.id, status: pool.status, startedAt: pool.startedAt, rampDay: pool.rampDay })
    .from(pool)
    .where(byTenantMailbox(input.clerkOrgId, input.tenantMailboxId))
    .limit(1);

  if (existing) {
    const status = existing.status === 'removed' ? unpausedStatus(existing) : existing.status;
    await master
      .update(pool)
      .set({ ...values, status, lastLoginError: null, lastLoginErrorAt: null })
      .where(eq(pool.id, existing.id));
    return { id: existing.id };
  }

  const id = generateId('rwmb');
  await master.insert(pool).values({ id, ...values, status: 'waiting', createdAt: now });
  return { id };
}

/** Keep the sender name in step with the tenant mailbox. No-op when the mailbox is not in the pool. */
export async function updatePoolMailboxProfile(
  master: MasterDatabase,
  clerkOrgId: string,
  tenantMailboxId: string,
  profile: { firstName?: string; lastName?: string },
): Promise<void> {
  const patch: Partial<typeof pool.$inferInsert> = { updatedAt: new Date() };
  if (profile.firstName !== undefined) patch.firstName = profile.firstName;
  if (profile.lastName !== undefined) patch.lastName = profile.lastName;
  await master.update(pool).set(patch).where(byTenantMailbox(clerkOrgId, tenantMailboxId));
}

/** Pause a mailbox's warmup (it neither sends nor receives warmup mail). */
export async function pausePoolMailbox(
  master: MasterDatabase,
  clerkOrgId: string,
  tenantMailboxId: string,
  reason: string,
): Promise<void> {
  await master
    .update(pool)
    .set({ status: 'paused', pausedReason: reason.slice(0, 100), updatedAt: new Date() })
    .where(and(byTenantMailbox(clerkOrgId, tenantMailboxId), ne(pool.status, 'removed')));
}

/** Set by WeldSuite staff in the admin console; only staff lift it. */
export const STAFF_PAUSE_REASON = 'paused_by_staff';

/**
 * Resume a paused mailbox where its warmup had got to. A staff pause stays:
 * the workspace resuming its mailbox does not override WeldSuite.
 */
export async function resumePoolMailbox(master: MasterDatabase, clerkOrgId: string, tenantMailboxId: string): Promise<void> {
  const [row] = await master
    .select({ id: pool.id, status: pool.status, startedAt: pool.startedAt, rampDay: pool.rampDay, pausedReason: pool.pausedReason })
    .from(pool)
    .where(byTenantMailbox(clerkOrgId, tenantMailboxId))
    .limit(1);
  if (!row || row.status !== 'paused' || row.pausedReason === STAFF_PAUSE_REASON) return;
  await master
    .update(pool)
    .set({ status: unpausedStatus(row), pausedReason: null, updatedAt: new Date() })
    .where(eq(pool.id, row.id));
}

/**
 * Take a mailbox out of the pool for good. Its scheduled warmup mail is
 * cancelled; the logins are overwritten so nothing usable stays behind.
 */
export async function removePoolMailbox(master: MasterDatabase, clerkOrgId: string, tenantMailboxId: string): Promise<void> {
  const [row] = await master
    .select({ id: pool.id })
    .from(pool)
    .where(byTenantMailbox(clerkOrgId, tenantMailboxId))
    .limit(1);
  if (!row) return;
  await master
    .update(pool)
    .set({ status: 'removed', smtpCredentials: '', imapCredentials: '', updatedAt: new Date() })
    .where(eq(pool.id, row.id));
  // Either side of a scheduled message may be the removed mailbox.
  await master
    .update(messages)
    .set({ status: 'failed', error: 'mailbox_removed' })
    .where(and(eq(messages.status, 'scheduled'), or(eq(messages.fromMailboxId, row.id), eq(messages.toMailboxId, row.id))));
}

/** A workspace's pool rows, without logins: the warmup state reach-api shows and gates on. */
export interface PoolMailboxView {
  tenantMailboxId: string;
  status: ReachWarmupStatus;
  startedAt: Date | null;
  rampDay: number;
  stats: PoolRow['stats'];
  pausedReason: string | null;
  lastLoginError: string | null;
  lastLoginErrorAt: Date | null;
}

export async function readPoolMailboxes(master: AnyMasterDatabase, clerkOrgId: string): Promise<PoolMailboxView[]> {
  return master
    .select({
      tenantMailboxId: pool.tenantMailboxId,
      status: pool.status,
      startedAt: pool.startedAt,
      rampDay: pool.rampDay,
      stats: pool.stats,
      pausedReason: pool.pausedReason,
      lastLoginError: pool.lastLoginError,
      lastLoginErrorAt: pool.lastLoginErrorAt,
    })
    .from(pool)
    .where(and(eq(pool.clerkOrgId, clerkOrgId), ne(pool.status, 'removed')));
}

/** Distinct domains among mailboxes that take part (waiting, warming, maintaining). */
export async function activePoolDomainCount(master: AnyMasterDatabase): Promise<number> {
  const [row] = await master
    .select({ n: countDistinct(pool.domain) })
    .from(pool)
    .where(inArray(pool.status, ['waiting', 'warming', 'maintaining']));
  return Number(row?.n ?? 0);
}

/**
 * Which of these Message-IDs (without angle brackets) belong to warmup mail.
 * reach-api drops forwarded warmup mail with this before it opens the tenant.
 */
export async function findWarmupMessageIds(master: MasterDatabase, messageIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(messageIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (ids.length === 0) return new Set();
  const rows = await master
    .select({ messageIdHeader: messages.messageIdHeader })
    .from(messages)
    .where(inArray(messages.messageIdHeader, ids));
  return new Set(rows.map((r) => r.messageIdHeader));
}
