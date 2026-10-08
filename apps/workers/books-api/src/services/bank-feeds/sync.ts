/**
 * Sync one bank connection into the books: posted transactions become
 * unreconciled `bank_transactions` (source `feed`), pending ones stay in
 * `bank_feed_pending_transactions`, removals soft-delete what is still
 * unreconciled, balances land on the bank accounts.
 *
 * Idempotent by construction: webhooks arrive at least once and out of order,
 * and a run that dies half way is simply run again from the last stored
 * cursor. Rows are unique on (bank account, provider, provider transaction id);
 * a lock in the connection's metadata keeps two runs from overlapping.
 */

import { and, eq, inArray, isNull, lt, or, sql, gte, lte, ne } from 'drizzle-orm';
import {
  FeedProviderError,
  addDays,
  connectionStatus,
  decimalToMinor,
  matchPendingToPosted,
  minorToDecimalString,
  normalizeDescription,
  transactionFingerprint,
  type BankFeedProvider,
  type ConnectionStatus,
  type FeedTransaction,
  type PendingCandidate,
  type StoredConnection,
  type SyncResult,
} from '@weldsuite/bank-feeds';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { sealCredentials } from './credentials';
import { loadConnection, storedFeedAccounts, toStoredConnection, type ConnectionRow } from './connections';
import {
  INACTIVE_STATUSES,
  MAX_WARNINGS,
  SYNC_LOCK_MINUTES,
  type ConnectionWarning,
  type FeedContext,
  type StoredFeedAccount,
} from './types';

type BankAccountRow = typeof schema.bankAccounts.$inferSelect;
type BankTransactionRow = typeof schema.bankTransactions.$inferSelect;
type NewBankTransaction = typeof schema.bankTransactions.$inferInsert;

const connections = schema.bankConnections;
const bankAccounts = schema.bankAccounts;
const bankTransactions = schema.bankTransactions;
const pendingTable = schema.bankFeedPendingTransactions;

const INSERT_CHUNK = 100;
const ID_CHUNK = 400;
const MAX_PAGES = 200;
const MAX_RESTARTS = 3;

export interface SyncOutcome {
  connectionId: string;
  status: ConnectionStatus;
  skipped?: 'not_found' | 'not_active' | 'in_progress' | 'no_mapped_accounts';
  added: number;
  updated: number;
  removed: number;
  pending: number;
  pendingVoided: number;
  possibleDuplicates: number;
  autoReconciled: number;
  warnings: number;
  error?: string;
  /** A later retry can succeed (rate limit, outage); a sweeper should try again soon. */
  retryable?: boolean;
}

function emptyOutcome(connectionId: string, status: ConnectionStatus): SyncOutcome {
  return { connectionId, status, added: 0, updated: 0, removed: 0, pending: 0, pendingVoided: 0, possibleDuplicates: 0, autoReconciled: 0, warnings: 0 };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const startOfDay = (date: string) => new Date(`${date}T00:00:00.000Z`);

// ── Lock ───────────────────────────────────────────────────────────────────

async function acquireLock(db: Database, id: string, at: Date): Promise<boolean> {
  const until = new Date(at.getTime() + SYNC_LOCK_MINUTES * 60_000).toISOString();
  const rows = await db
    .update(connections)
    .set({ metadata: sql`jsonb_set(coalesce(${connections.metadata}, '{}'::jsonb), '{syncLockUntil}', to_jsonb(${until}::text))` })
    .where(
      and(
        eq(connections.id, id),
        sql`(${connections.metadata}->>'syncLockUntil' is null or (${connections.metadata}->>'syncLockUntil')::timestamptz < ${at.toISOString()}::timestamptz)`,
      ),
    )
    .returning({ id: connections.id });
  return rows.length > 0;
}

/** Merge `patch` into the metadata and drop the lock in one statement, so concurrent metadata writers are not clobbered. */
function releasingMetadata(patch: Record<string, unknown>) {
  return sql`((coalesce(${connections.metadata}, '{}'::jsonb) - 'syncLockUntil') || ${JSON.stringify(patch)}::jsonb)`;
}

/**
 * Accounts mapped while this run was reading (`metadata.resyncAt` later than the run's start) need
 * their history read from the beginning, which this run's cursor skipped: keep the cursor reset
 * and the flag. A run that started after the mapping read from the start already and clears it.
 */
function cursorAfterRun(cursor: unknown, startedAt: Date) {
  return sql`CASE WHEN (${connections.metadata}->>'resyncAt')::timestamptz > ${startedAt.toISOString()}::timestamptz THEN NULL ELSE ${JSON.stringify(cursor ?? null)}::jsonb END`;
}

function finishedMetadata(patch: Record<string, unknown>, startedAt: Date) {
  return sql`((CASE WHEN (${connections.metadata}->>'resyncAt')::timestamptz > ${startedAt.toISOString()}::timestamptz THEN coalesce(${connections.metadata}, '{}'::jsonb) ELSE coalesce(${connections.metadata}, '{}'::jsonb) - 'resyncAt' END - 'syncLockUntil') || ${JSON.stringify(patch)}::jsonb)`;
}

// ── Page application ───────────────────────────────────────────────────────

interface RunState {
  provider: BankFeedProvider;
  row: ConnectionRow;
  byFeedId: Map<string, BankAccountRow>;
  timestamp: Date;
  occurrences: Map<string, number>;
  pendingPool: PendingCandidate[] | null;
  warnings: ConnectionWarning[];
  touchedAccounts: Set<string>;
  outcome: SyncOutcome;
}

type Statement = (handle: Database) => unknown;

function sameAmount(existing: string, minor: number, currency: string): boolean {
  return decimalToMinor(existing, currency) === minor;
}

function needsUpdate(existing: BankTransactionRow, tx: FeedTransaction): boolean {
  return (
    !sameAmount(existing.amount, tx.amountMinor, tx.currency) ||
    dayOf(existing.date) !== tx.date ||
    (existing.description ?? '') !== tx.description ||
    (existing.merchantName ?? null) !== (tx.merchantName ?? null) ||
    (existing.checkNumber ?? null) !== (tx.checkNumber ?? null)
  );
}

async function loadPendingPool(db: Database, run: RunState): Promise<PendingCandidate[]> {
  const rows = await db
    .select()
    .from(pendingTable)
    .where(and(eq(pendingTable.connectionId, run.row.id), isNull(pendingTable.voidedAt)));
  return rows.map((r) => ({
    id: r.providerTransactionId,
    accountId: r.bankAccountId,
    date: r.date,
    amountMinor: decimalToMinor(r.amount, r.currency),
    description: r.description,
  }));
}

async function applyPage(
  db: Database,
  run: RunState,
  page: Pick<SyncResult, 'upserts' | 'removals'>,
): Promise<void> {
  const { provider, row, byFeedId, timestamp } = run;
  const accountIds = [...new Set([...byFeedId.values()].map((a) => a.id))];

  // The last version of an id in a page wins; an id that is also "removed" was just re-sent.
  const latest = new Map<string, FeedTransaction>();
  for (const tx of page.upserts) latest.set(tx.providerTransactionId, tx);
  const removalIds = [...new Set(page.removals)].filter((id) => !latest.has(id));

  const posted: Array<{ tx: FeedTransaction; account: BankAccountRow }> = [];
  const pendingRows: Array<typeof pendingTable.$inferInsert> = [];
  for (const tx of latest.values()) {
    const account = byFeedId.get(tx.accountId);
    if (!account) continue;
    if (account.feedSyncFrom && tx.date < account.feedSyncFrom) continue;
    if (tx.pending) {
      pendingRows.push({
        id: generateId('bfp'),
        entityId: account.entityId,
        bankAccountId: account.id,
        connectionId: row.id,
        provider: provider.id,
        providerTransactionId: tx.providerTransactionId,
        date: tx.date,
        amount: minorToDecimalString(tx.amountMinor, tx.currency),
        currency: tx.currency,
        description: tx.description,
        merchantName: tx.merchantName ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } else {
      posted.push({ tx, account });
    }
  }

  const statements: Statement[] = [];

  // ── Posted transactions ──
  const existingRows: BankTransactionRow[] = [];
  const postedIds = posted.map((p) => p.tx.providerTransactionId);
  for (const ids of chunk(postedIds, ID_CHUNK)) {
    existingRows.push(
      ...(await db
        .select()
        .from(bankTransactions)
        .where(
          and(
            inArray(bankTransactions.bankAccountId, accountIds),
            eq(bankTransactions.feedProvider, provider.id),
            inArray(bankTransactions.providerTransactionId, ids),
          ),
        )),
    );
  }
  const existingByKey = new Map(existingRows.map((r) => [`${r.bankAccountId}|${r.providerTransactionId}`, r]));

  const inserts: Array<{ values: NewBankTransaction; firstFingerprint: string; currency: string; day: string }> = [];
  const updates: Array<{ id: string; values: Partial<NewBankTransaction> }> = [];

  for (const { tx, account } of posted) {
    const description = normalizeDescription(tx.description);
    const occurrenceKey = `${account.id}|${tx.date}|${tx.amountMinor}|${description}`;
    const occurrence = run.occurrences.get(occurrenceKey) ?? 0;
    run.occurrences.set(occurrenceKey, occurrence + 1);
    const fingerprint = await transactionFingerprint(tx.date, tx.amountMinor, description, occurrence);
    const firstFingerprint = occurrence === 0 ? fingerprint : await transactionFingerprint(tx.date, tx.amountMinor, description, 0);

    const fields = {
      date: startOfDay(tx.date),
      description: tx.description,
      amount: minorToDecimalString(tx.amountMinor, tx.currency),
      counterpartyName: tx.merchantName ?? null,
      checkNumber: tx.checkNumber ?? null,
      merchantName: tx.merchantName ?? null,
      feedCategory: tx.category ?? null,
      rawData: tx.raw,
      fingerprint,
    };

    const existing = existingByKey.get(`${account.id}|${tx.providerTransactionId}`);
    if (!existing) {
      inserts.push({
        values: {
          id: generateId('bt'),
          entityId: account.entityId,
          bankAccountId: account.id,
          status: 'unreconciled',
          source: 'feed',
          feedProvider: provider.id,
          providerTransactionId: tx.providerTransactionId,
          createdAt: timestamp,
          updatedAt: timestamp,
          ...fields,
        },
        firstFingerprint,
        currency: tx.currency,
        day: tx.date,
      });
    } else if (existing.deletedAt) {
      // Removed earlier, sent again: bring it back as it is now.
      updates.push({ id: existing.id, values: { ...fields, deletedAt: null, status: 'unreconciled', updatedAt: timestamp } });
      run.touchedAccounts.add(account.id);
      run.outcome.updated += 1;
    } else if (existing.status === 'unreconciled' && !existing.journalEntryId && needsUpdate(existing, tx)) {
      // Still unreconciled: the bank changed the line (amount, wording), follow it.
      updates.push({ id: existing.id, values: { ...fields, updatedAt: timestamp } });
      run.outcome.updated += 1;
    }
  }

  // Lines the same account already has from a file import: flag, never merge.
  if (inserts.length > 0) {
    const days = inserts.map((i) => i.day).sort();
    const insertAccountIds = [...new Set(inserts.map((i) => i.values.bankAccountId))];
    const candidates = await db
      .select()
      .from(bankTransactions)
      .where(
        and(
          inArray(bankTransactions.bankAccountId, insertAccountIds),
          isNull(bankTransactions.deletedAt),
          or(isNull(bankTransactions.source), ne(bankTransactions.source, 'feed')),
          gte(bankTransactions.date, startOfDay(days[0] as string)),
          lte(bankTransactions.date, new Date(`${days[days.length - 1]}T23:59:59.999Z`)),
        ),
      );
    const currencyOf = new Map([...byFeedId.values()].map((a) => [a.id, a.currency ?? 'USD']));
    const imported = new Map<string, string>();
    for (const candidate of candidates) {
      const currency = currencyOf.get(candidate.bankAccountId) ?? 'USD';
      const fingerprint =
        candidate.fingerprint ??
        (await transactionFingerprint(dayOf(candidate.date), decimalToMinor(candidate.amount, currency), normalizeDescription(candidate.description), 0));
      imported.set(`${candidate.bankAccountId}|${fingerprint}`, candidate.id);
    }
    for (const insert of inserts) {
      const duplicateOf = imported.get(`${insert.values.bankAccountId}|${insert.firstFingerprint}`);
      if (duplicateOf) {
        insert.values.possibleDuplicateOfId = duplicateOf;
        run.outcome.possibleDuplicates += 1;
      }
    }
  }

  for (const part of chunk(inserts, INSERT_CHUNK)) {
    statements.push((h) => h.insert(bankTransactions).values(part.map((p) => p.values)).onConflictDoNothing());
  }
  for (const insert of inserts) run.touchedAccounts.add(insert.values.bankAccountId);
  run.outcome.added += inserts.length;
  for (const update of updates) {
    statements.push((h) => h.update(bankTransactions).set(update.values).where(eq(bankTransactions.id, update.id)));
  }

  // ── Pending transactions ──
  for (const part of chunk(pendingRows, INSERT_CHUNK)) {
    statements.push((h) =>
      h
        .insert(pendingTable)
        .values(part)
        .onConflictDoUpdate({
          target: [pendingTable.provider, pendingTable.providerTransactionId],
          set: {
            bankAccountId: sql`excluded.bank_account_id`,
            date: sql`excluded.date`,
            amount: sql`excluded.amount`,
            currency: sql`excluded.currency`,
            description: sql`excluded.description`,
            merchantName: sql`excluded.merchant_name`,
            voidedAt: null,
            updatedAt: timestamp,
          },
        }),
    );
  }
  run.outcome.pending += pendingRows.length;

  // A posted transaction replaces its pending row: by id (Stripe FC changes status in place), by the
  // provider's link (Plaid), or, for providers with neither, by amount, a ten day window and description.
  const replacedPending = new Set<string>();
  for (const { tx, account } of posted) {
    replacedPending.add(tx.providerTransactionId);
    if (tx.pendingTransactionId) replacedPending.add(tx.pendingTransactionId);
    if (!tx.pendingTransactionId && !provider.capabilities.changeCursor && provider.capabilities.pendingTransactions) {
      run.pendingPool ??= await loadPendingPool(db, run);
      const match = matchPendingToPosted(
        { accountId: account.id, date: tx.date, amountMinor: tx.amountMinor, description: tx.description },
        run.pendingPool,
      );
      if (match) {
        replacedPending.add(match.id);
        run.pendingPool = run.pendingPool.filter((c) => c.id !== match.id);
      }
    }
  }
  for (const ids of chunk([...replacedPending, ...removalIds], ID_CHUNK)) {
    statements.push((h) => h.delete(pendingTable).where(and(eq(pendingTable.provider, provider.id), inArray(pendingTable.providerTransactionId, ids))));
  }

  // ── Removals ──
  const softDelete: string[] = [];
  for (const ids of chunk(removalIds, ID_CHUNK)) {
    const rows = await db
      .select()
      .from(bankTransactions)
      .where(
        and(
          inArray(bankTransactions.bankAccountId, accountIds),
          eq(bankTransactions.feedProvider, provider.id),
          inArray(bankTransactions.providerTransactionId, ids),
          isNull(bankTransactions.deletedAt),
        ),
      );
    for (const r of rows) {
      if (r.status === 'unreconciled' && !r.journalEntryId) {
        softDelete.push(r.id);
      } else {
        run.warnings.push({
          at: timestamp.toISOString(),
          code: 'removed_reconciled',
          message: 'The bank removed a transaction that is already reconciled; it was kept.',
          providerTransactionId: r.providerTransactionId ?? undefined,
          bankTransactionId: r.id,
        });
      }
    }
  }
  for (const ids of chunk(softDelete, ID_CHUNK)) {
    statements.push((h) => h.update(bankTransactions).set({ deletedAt: timestamp, updatedAt: timestamp }).where(inArray(bankTransactions.id, ids)));
  }
  run.outcome.removed += softDelete.length;

  if (statements.length > 0) await atomically(db, (h) => statements.map((s) => s(h)));
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function syncConnection(
  ctx: FeedContext,
  connectionId: string,
  options: { refresh?: boolean } = {},
): Promise<SyncOutcome> {
  const row = await loadConnection(ctx.db, connectionId);
  if (!row) return { ...emptyOutcome(connectionId, 'disconnected'), skipped: 'not_found' };
  const status = row.status as ConnectionStatus;
  if (status === 'disconnected' || status === 'revoked') return { ...emptyOutcome(connectionId, status), skipped: 'not_active' };

  let provider: BankFeedProvider;
  try {
    provider = ctx.getProvider(row.provider);
  } catch (err) {
    return { ...emptyOutcome(connectionId, status), error: err instanceof Error ? err.message : 'Provider not configured' };
  }

  const timestamp = ctx.now ? ctx.now() : new Date();
  if (!(await acquireLock(ctx.db, row.id, timestamp))) return { ...emptyOutcome(connectionId, status), skipped: 'in_progress' };

  const outcome = emptyOutcome(connectionId, status);
  try {
    return await runSync(ctx, provider, row, timestamp, outcome, options);
  } catch (err) {
    if (err instanceof FeedProviderError) return recordFailure(ctx, row, err, timestamp, outcome);
    await ctx.db.update(connections).set({ metadata: releasingMetadata({}) }).where(eq(connections.id, row.id)).catch(() => undefined);
    throw err;
  }
}

async function runSync(
  ctx: FeedContext,
  provider: BankFeedProvider,
  row: ConnectionRow,
  timestamp: Date,
  outcome: SyncOutcome,
  options: { refresh?: boolean },
): Promise<SyncOutcome> {
  const { db } = ctx;
  const mapped = (
    await db.select().from(bankAccounts).where(and(eq(bankAccounts.feedConnectionId, row.id), isNull(bankAccounts.deletedAt)))
  ).filter((a) => a.feedAccountId);

  if (mapped.length === 0) {
    await db.update(connections).set({ metadata: releasingMetadata({}) }).where(eq(connections.id, row.id));
    return { ...outcome, skipped: 'no_mapped_accounts' };
  }

  const byFeedId = new Map(mapped.map((a) => [a.feedAccountId as string, a]));
  let stored: StoredConnection = await toStoredConnection(ctx, row, [...byFeedId.keys()]);
  let credentialsUpdate: Record<string, unknown> | null = null;

  if (options.refresh && provider.capabilities.onDemandRefresh && provider.refresh) {
    try {
      await provider.refresh(stored);
    } catch (err) {
      // A refused refresh (rate limit) must not stop the read of what the provider already has.
      console.warn(`[bank-feeds] refresh failed for ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }

  const run: RunState = {
    provider,
    row,
    byFeedId,
    timestamp,
    occurrences: new Map(),
    pendingPool: null,
    warnings: [],
    touchedAccounts: new Set(),
    outcome,
  };

  const startCursor: unknown = row.syncCursor ?? null;
  let cursor = startCursor;
  const accountStatuses: Record<string, ConnectionStatus> = {};
  let restarts = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result: SyncResult;
    try {
      result = await provider.syncTransactions(stored, cursor);
    } catch (err) {
      // Plaid: data changed between pages. Every write is idempotent, so start the loop over.
      if (err instanceof FeedProviderError && err.kind === 'mutation_during_pagination' && restarts < MAX_RESTARTS) {
        restarts += 1;
        cursor = startCursor;
        page = -1;
        continue;
      }
      throw err;
    }

    await applyPage(db, run, result);
    Object.assign(accountStatuses, result.accountStatuses ?? {});
    if (result.credentials) {
      credentialsUpdate = result.credentials;
      stored = { ...stored, credentials: result.credentials };
    }
    cursor = result.nextCursor;
    if (!result.hasMore) break;
  }

  // Unmatched pending rows older than 14 days are void.
  const today = dayOf(timestamp);
  const voided = await db
    .update(pendingTable)
    .set({ voidedAt: timestamp, updatedAt: timestamp })
    .where(and(eq(pendingTable.connectionId, row.id), isNull(pendingTable.voidedAt), lt(pendingTable.date, addDays(today, -14))))
    .returning({ id: pendingTable.id });
  outcome.pendingVoided = voided.length;

  await updateBalances(db, provider, stored, byFeedId, timestamp);

  // Status: what the provider reported per account, else a clean read clears an earlier problem.
  const feedAccounts: StoredFeedAccount[] = storedFeedAccounts(row).map((fa) => {
    const reported = accountStatuses[fa.providerAccountId];
    if (reported) return { ...fa, status: reported };
    return fa.status === 'reauth_required' || fa.status === 'error' ? { ...fa, status: 'active' } : fa;
  });
  const mappedStatuses = feedAccounts.filter((fa) => byFeedId.has(fa.providerAccountId)).map((fa) => fa.status);
  let nextStatus = connectionStatus(mappedStatuses);
  if (nextStatus === 'active' && row.consentExpiresAt) {
    const daysLeft = (row.consentExpiresAt.getTime() - timestamp.getTime()) / 86_400_000;
    if (daysLeft <= 0) nextStatus = 'reauth_required';
    else if (daysLeft <= 14) nextStatus = 'expiring';
  } else if (nextStatus === 'active' && row.status === 'expiring') {
    nextStatus = 'expiring';
  }
  for (const [feedId, account] of byFeedId) {
    const feed = feedAccounts.find((fa) => fa.providerAccountId === feedId);
    if (feed && feed.status !== account.feedStatus) {
      await db.update(bankAccounts).set({ feedStatus: feed.status, updatedAt: timestamp }).where(eq(bankAccounts.id, account.id));
    }
  }

  // Reconciliation matcher over the new lines.
  if (ctx.autoReconcile) {
    for (const accountId of run.touchedAccounts) {
      const account = mapped.find((a) => a.id === accountId);
      if (account && account.autoReconcile === false) continue;
      try {
        outcome.autoReconciled += await ctx.autoReconcile(db, accountId);
      } catch (err) {
        console.warn(`[bank-feeds] auto-reconcile skipped for ${accountId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  const warnings = [...warningsOf(row), ...run.warnings].slice(-MAX_WARNINGS);
  outcome.warnings = run.warnings.length;
  outcome.status = nextStatus;

  const credentialsEncrypted = credentialsUpdate ? await sealCredentials(credentialsUpdate, ctx.keyring) : undefined;
  await db
    .update(connections)
    .set({
      status: nextStatus,
      syncCursor: cursorAfterRun(cursor, timestamp),
      lastSyncedAt: timestamp,
      lastError: null,
      ...(credentialsEncrypted ? { credentialsEncrypted } : {}),
      metadata: finishedMetadata(
        {
          feedAccounts,
          warnings,
          lastSync: {
            at: timestamp.toISOString(),
            added: outcome.added,
            updated: outcome.updated,
            removed: outcome.removed,
            pending: outcome.pending,
          },
        },
        timestamp,
      ),
      updatedAt: timestamp,
    })
    .where(eq(connections.id, row.id));

  const wasInactive = INACTIVE_STATUSES.has(row.status as ConnectionStatus);
  const nowInactive = INACTIVE_STATUSES.has(nextStatus);
  if (wasInactive && !nowInactive) await ctx.index.setActive(row.id, true, null);
  else if (!wasInactive && nowInactive) await ctx.index.setActive(row.id, false, `Connection needs attention: ${nextStatus}`);

  return outcome;
}

function warningsOf(row: ConnectionRow): ConnectionWarning[] {
  const list = (row.metadata as { warnings?: unknown } | null)?.warnings;
  return Array.isArray(list) ? (list as ConnectionWarning[]) : [];
}

async function updateBalances(
  db: Database,
  provider: BankFeedProvider,
  stored: StoredConnection,
  byFeedId: Map<string, BankAccountRow>,
  timestamp: Date,
): Promise<void> {
  try {
    for (const balance of await provider.getBalances(stored)) {
      const account = byFeedId.get(balance.accountId);
      if (!account) continue;
      const amount = minorToDecimalString(balance.current, balance.currency);
      await db
        .update(bankAccounts)
        .set({ currentBalance: amount, lastImportBalance: amount, lastImportDate: timestamp, updatedAt: timestamp })
        .where(eq(bankAccounts.id, account.id));
    }
  } catch (err) {
    // Balances are a nicety next to the transactions already stored.
    console.warn('[bank-feeds] balance read failed:', err instanceof Error ? err.message : err);
  }
}

async function recordFailure(
  ctx: FeedContext,
  row: ConnectionRow,
  err: FeedProviderError,
  timestamp: Date,
  outcome: SyncOutcome,
): Promise<SyncOutcome> {
  let status = row.status as ConnectionStatus;
  let retryable = false;
  switch (err.kind) {
    case 'reauth_required':
      status = 'reauth_required';
      break;
    case 'revoked':
      status = 'revoked';
      break;
    case 'rate_limit':
    case 'transient':
    case 'mutation_during_pagination':
      retryable = true;
      break;
    default:
      status = 'error';
  }

  const message = err.message.slice(0, 500);
  const patch: Record<string, unknown> = {};
  if (status === 'reauth_required' || status === 'revoked') {
    patch.feedAccounts = storedFeedAccounts(row).map((fa) => ({ ...fa, status }));
  }
  await ctx.db
    .update(connections)
    .set({ status, lastError: message, metadata: releasingMetadata(patch), updatedAt: timestamp })
    .where(eq(connections.id, row.id));
  if (status === 'reauth_required' || status === 'revoked') {
    await ctx.db
      .update(bankAccounts)
      .set({ feedStatus: status, updatedAt: timestamp })
      .where(and(eq(bankAccounts.feedConnectionId, row.id), isNull(bankAccounts.deletedAt)));
    await ctx.index.setActive(row.id, false, message);
  }

  return { ...outcome, status, error: message, retryable };
}
