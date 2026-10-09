/**
 * Bank feed connections: link sessions, completing a link, mapping feed
 * accounts to WeldBooks bank accounts, disconnecting. Provider calls go through
 * `@weldsuite/bank-feeds`; tokens are encrypted at rest and never returned.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  connectionStatus,
  normalizeIban,
  type ConnectionStatus,
  type FeedAccount,
  type LinkMode,
  type LinkSession,
  type StoredConnection,
} from '@weldsuite/bank-feeds';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { openCredentials, sealCredentials } from './credentials';
import { FeedServiceError, translateProviderError } from './errors';
import { createLedgerAccountForBank, type BankAccountType } from './ledger';
import {
  DEFAULT_HISTORY_DAYS,
  INACTIVE_STATUSES,
  type ConnectionAccountView,
  type ConnectionView,
  type ConnectionWarning,
  type FeedContext,
  type MappingSuggestion,
  type StoredFeedAccount,
} from './types';

export type ConnectionRow = typeof schema.bankConnections.$inferSelect;
type BankAccountRow = typeof schema.bankAccounts.$inferSelect;

const connections = schema.bankConnections;
const bankAccounts = schema.bankAccounts;

const now = (ctx: FeedContext) => (ctx.now ? ctx.now() : new Date());

// ── Reading ────────────────────────────────────────────────────────────────

export async function loadConnection(db: Database, id: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), isNull(connections.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function requireConnection(db: Database, id: string, entityId?: string | null): Promise<ConnectionRow> {
  const row = await loadConnection(db, id);
  if (!row || (entityId && row.entityId !== entityId)) throw new FeedServiceError('not_found', `Bank connection '${id}' not found`);
  return row;
}

export function storedFeedAccounts(row: ConnectionRow): StoredFeedAccount[] {
  const list = (row.metadata as { feedAccounts?: unknown } | null)?.feedAccounts;
  return Array.isArray(list) ? (list as StoredFeedAccount[]) : [];
}

function warningsOf(row: ConnectionRow): ConnectionWarning[] {
  const list = (row.metadata as { warnings?: unknown } | null)?.warnings;
  return Array.isArray(list) ? (list as ConnectionWarning[]).slice(-20) : [];
}

function toStoredFeedAccount(account: FeedAccount): StoredFeedAccount {
  return {
    providerAccountId: account.providerAccountId,
    name: account.name,
    mask: account.mask,
    iban: account.iban ?? null,
    type: account.type,
    subtype: account.subtype,
    currency: account.currency,
    fingerprint: account.fingerprint,
    status: account.status ?? 'active',
  };
}

export async function toStoredConnection(ctx: FeedContext, row: ConnectionRow, accountIds?: string[]): Promise<StoredConnection> {
  return {
    provider: row.provider,
    providerConnectionId: row.providerConnectionId,
    credentials: await openCredentials(row.credentialsEncrypted, ctx.keyring),
    cursor: row.syncCursor ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    historyDays: row.historyDays,
    accountIds,
  };
}

function reasonableName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The WeldBooks bank account a new feed account most likely belongs to. */
function suggestionFor(account: StoredFeedAccount, candidates: BankAccountRow[]): MappingSuggestion | null {
  const named = (ba: BankAccountRow, reason: MappingSuggestion['reason']): MappingSuggestion => ({
    bankAccountId: ba.id,
    bankAccountName: ba.name,
    reason,
  });

  const byFingerprint = candidates.find((ba) => ba.feedAccountFingerprint && ba.feedAccountFingerprint === account.fingerprint);
  if (byFingerprint) return named(byFingerprint, 'fingerprint');

  if (account.iban) {
    const iban = normalizeIban(account.iban);
    const byIban = candidates.find((ba) => ba.iban && normalizeIban(ba.iban) === iban);
    if (byIban) return named(byIban, 'iban');
  }

  if (account.mask) {
    const byLast4 = candidates.find(
      (ba) => ba.accountNumberLast4 === account.mask || (ba.iban && normalizeIban(ba.iban).endsWith(account.mask as string)),
    );
    if (byLast4) return named(byLast4, 'last4');
  }

  const name = reasonableName(account.name);
  const byName = candidates.find((ba) => reasonableName(ba.name) === name);
  return byName ? named(byName, 'name') : null;
}

export async function connectionViews(
  ctx: FeedContext,
  rows: ConnectionRow[],
  options: { suggestions?: boolean } = {},
): Promise<ConnectionView[]> {
  if (rows.length === 0) return [];
  const accounts = await ctx.db
    .select()
    .from(bankAccounts)
    .where(and(inArray(bankAccounts.feedConnectionId, rows.map((r) => r.id)), isNull(bankAccounts.deletedAt)));

  const views: ConnectionView[] = [];
  for (const row of rows) {
    const mapped = accounts.filter((a) => a.feedConnectionId === row.id);
    const feedAccounts = storedFeedAccounts(row);
    let candidates: BankAccountRow[] = [];
    if (options.suggestions && feedAccounts.some((fa) => !mapped.some((m) => m.feedAccountId === fa.providerAccountId))) {
      const all = await ctx.db
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.entityId, row.entityId), isNull(bankAccounts.deletedAt)));
      candidates = all.filter((ba) => !ba.feedConnectionId || ba.feedStatus === 'disconnected' || ba.feedStatus === 'revoked');
    }

    const accountViews: ConnectionAccountView[] = feedAccounts.map((fa) => {
      const bank = mapped.find((m) => m.feedAccountId === fa.providerAccountId) ?? null;
      const view: ConnectionAccountView = {
        feedAccountId: fa.providerAccountId,
        name: fa.name,
        mask: fa.mask,
        type: fa.type,
        subtype: fa.subtype,
        currency: fa.currency,
        status: fa.status,
        bankAccountId: bank?.id ?? null,
        bankAccountName: bank?.name ?? null,
        syncFrom: bank?.feedSyncFrom ?? null,
      };
      if (options.suggestions && !bank) {
        const suggestion = suggestionFor(fa, candidates);
        view.suggestion = suggestion;
        if (suggestion) candidates = candidates.filter((c) => c.id !== suggestion.bankAccountId);
      }
      return view;
    });

    let capabilities = null;
    try {
      capabilities = ctx.getProvider(row.provider).capabilities;
    } catch {
      // provider no longer configured: the connection is still listed
    }

    views.push({
      id: row.id,
      entityId: row.entityId,
      provider: row.provider,
      institutionId: row.institutionId,
      institutionName: row.institutionName,
      status: row.status as ConnectionStatus,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastError: row.lastError,
      consentExpiresAt: row.consentExpiresAt?.toISOString() ?? null,
      historyDays: row.historyDays,
      createdAt: row.createdAt.toISOString(),
      capabilities,
      accounts: accountViews,
      warnings: warningsOf(row),
    });
  }
  return views;
}

export async function listConnectionViews(ctx: FeedContext, entityId: string): Promise<ConnectionView[]> {
  const rows = await ctx.db
    .select()
    .from(connections)
    .where(and(eq(connections.entityId, entityId), isNull(connections.deletedAt)))
    .orderBy(desc(connections.createdAt));
  return connectionViews(ctx, rows);
}

export async function connectionViewById(ctx: FeedContext, id: string, options: { suggestions?: boolean } = {}): Promise<ConnectionView> {
  const row = await requireConnection(ctx.db, id);
  const [view] = await connectionViews(ctx, [row], options);
  if (!view) throw new FeedServiceError('not_found', `Bank connection '${id}' not found`);
  return view;
}

// ── Link ───────────────────────────────────────────────────────────────────

export async function createLinkSession(
  ctx: FeedContext,
  args: {
    providerId: string;
    mode: LinkMode;
    connectionId?: string;
    workspaceId: string;
    redirectUrl: string;
    institution?: { id?: string; name: string; country: string };
    psuType?: 'business' | 'personal';
  },
): Promise<LinkSession & { provider: string; historyDays: number }> {
  let provider;
  try {
    provider = ctx.getProvider(args.providerId);
  } catch (err) {
    throw translateProviderError(err) ?? err;
  }

  let stored: StoredConnection | undefined;
  if (args.mode !== 'create') {
    if (!args.connectionId) throw new FeedServiceError('bad_request', 'connectionId is required to reconnect or add accounts');
    const row = await requireConnection(ctx.db, args.connectionId);
    if (row.provider !== provider.id) throw new FeedServiceError('bad_request', 'The connection belongs to another provider');
    stored = await toStoredConnection(ctx, row);
  }

  const historyDays = Math.min(provider.capabilities.maxHistoryDays, DEFAULT_HISTORY_DAYS);
  try {
    const session = await provider.createLinkSession({
      workspaceId: args.workspaceId,
      mode: args.mode,
      connectionId: args.connectionId,
      historyDays,
      redirectUrl: args.redirectUrl,
      connection: stored,
      institution: args.institution,
      psuType: args.psuType,
    });
    return { ...session, provider: provider.id, historyDays };
  } catch (err) {
    throw translateProviderError(err) ?? err;
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Accounts the new link reports replace same-id and same-fingerprint entries; others stay (add_accounts). */
function mergeFeedAccounts(existing: StoredFeedAccount[], incoming: StoredFeedAccount[]): StoredFeedAccount[] {
  const kept = existing.filter(
    (old) => !incoming.some((n) => n.providerAccountId === old.providerAccountId || n.fingerprint === old.fingerprint),
  );
  return [...kept, ...incoming];
}

export async function completeLink(
  ctx: FeedContext,
  args: { providerId: string; payload: unknown; connectionId?: string; entityId: string; userId: string | null },
): Promise<{ view: ConnectionView; created: boolean }> {
  let provider;
  try {
    provider = ctx.getProvider(args.providerId);
  } catch (err) {
    throw translateProviderError(err) ?? err;
  }

  let existing: ConnectionRow | null = null;
  // The stored connection only ever comes from our own database, never from the client.
  const { connection: _fromClient, ...clientPayload } = asObject(args.payload);
  let payload: Record<string, unknown> = clientPayload;
  if (args.connectionId) {
    existing = await requireConnection(ctx.db, args.connectionId, args.entityId);
    if (existing.provider !== provider.id) throw new FeedServiceError('bad_request', 'The connection belongs to another provider');
    payload = { ...payload, connection: await toStoredConnection(ctx, existing) };
  }

  let linked;
  try {
    linked = await provider.completeLink(payload);
  } catch (err) {
    throw translateProviderError(err) ?? err;
  }
  const { connection, accounts } = linked;

  if (!existing) {
    // Completing the same link twice (a double submit) must not create a second connection.
    const [duplicate] = await ctx.db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.provider, provider.id),
          eq(connections.providerConnectionId, connection.providerConnectionId),
          isNull(connections.deletedAt),
        ),
      )
      .limit(1);
    if (duplicate && duplicate.entityId !== args.entityId) {
      throw new FeedServiceError('conflict', 'This bank connection already belongs to another entity');
    }
    existing = duplicate ?? null;
  }

  const timestamp = now(ctx);
  const incoming = accounts.map(toStoredFeedAccount);
  const feedAccounts = existing ? mergeFeedAccounts(storedFeedAccounts(existing), incoming) : incoming;
  const credentialsEncrypted = await sealCredentials(connection.credentials, ctx.keyring);
  const consentExpiresAt = connection.consentExpiresAt ? new Date(connection.consentExpiresAt) : null;
  const metadata = {
    ...((existing?.metadata as Record<string, unknown> | null) ?? {}),
    ...(connection.metadata ?? {}),
    feedAccounts,
  };
  // A clean relink clears the problem, but an account that still needs the user keeps the connection flagged.
  const status = connection.status === 'active' ? connectionStatus(feedAccounts.map((a) => a.status)) : connection.status;

  let id: string;
  if (existing) {
    id = existing.id;
    await ctx.db
      .update(connections)
      .set({
        institutionId: clip(connection.institutionId, 100) ?? existing.institutionId,
        institutionName: clip(connection.institutionName, 255) ?? existing.institutionName,
        status,
        credentialsEncrypted,
        syncCursor: existing.syncCursor ?? connection.cursor ?? null,
        consentExpiresAt,
        lastError: null,
        metadata,
        updatedAt: timestamp,
      })
      .where(eq(connections.id, id));

    // A relink hands out new provider account ids: keep the bank accounts attached by fingerprint.
    const attached = await ctx.db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.feedConnectionId, id), isNull(bankAccounts.deletedAt)));
    for (const ba of attached) {
      const match = incoming.find((a) => a.fingerprint === ba.feedAccountFingerprint);
      if (!match) continue;
      await ctx.db
        .update(bankAccounts)
        .set({ feedAccountId: match.providerAccountId, feedStatus: match.status ?? 'active', updatedAt: timestamp })
        .where(eq(bankAccounts.id, ba.id));
    }
  } else {
    id = generateId('bkc');
    await ctx.db.insert(connections).values({
      id,
      entityId: args.entityId,
      provider: provider.id,
      providerConnectionId: connection.providerConnectionId,
      institutionId: clip(connection.institutionId, 100),
      institutionName: clip(connection.institutionName, 255),
      status,
      credentialsEncrypted,
      syncCursor: connection.cursor ?? null,
      consentExpiresAt,
      historyDays: Math.min(provider.capabilities.maxHistoryDays, DEFAULT_HISTORY_DAYS),
      createdBy: args.userId,
      metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  if (!INACTIVE_STATUSES.has(status)) {
    const intervalHours = provider.capabilities.webhooks ? 24 : 6;
    await ctx.index.upsert(
      (connection.indexKeys ?? [connection.providerConnectionId]).map((key) => ({
        provider: provider.id,
        providerConnectionId: key,
        clerkOrgId: ctx.clerkOrgId,
        connectionId: id,
        entityId: args.entityId,
        syncIntervalHours: intervalHours,
        nextSyncAt: new Date(timestamp.getTime() + intervalHours * 3_600_000),
      })),
    );
  }

  return { view: await connectionViewById(ctx, id, { suggestions: true }), created: !args.connectionId && !existing };
}

// ── Mapping ────────────────────────────────────────────────────────────────

export interface AccountMappingInput {
  feedAccountId: string;
  bankAccountId?: string;
  create?: { name: string; accountType?: BankAccountType; ledgerAccountId?: string };
  syncFrom?: string | null;
}

function defaultAccountType(account: StoredFeedAccount): BankAccountType {
  switch (account.subtype) {
    case 'savings':
      return 'savings';
    case 'money_market':
      return 'money_market';
    case 'credit_card':
      return 'credit_card';
    case 'line_of_credit':
      return 'line_of_credit';
    default:
      break;
  }
  if (account.type === 'credit') return 'credit_card';
  if (account.type === 'loan') return 'line_of_credit';
  return 'checking';
}

function lastFour(mask: string | null): string | null {
  return mask ? mask.slice(-4) : null;
}

export async function mapAccounts(
  ctx: FeedContext,
  connectionId: string,
  input: { mappings: AccountMappingInput[]; syncFrom?: string | null },
  entityId?: string | null,
): Promise<{ view: ConnectionView; mapped: Array<{ feedAccountId: string; bankAccountId: string; created: boolean }>; needsSync: boolean }> {
  const row = await requireConnection(ctx.db, connectionId, entityId);
  const feedAccounts = storedFeedAccounts(row);
  const timestamp = now(ctx);

  const seenFeed = new Set<string>();
  const seenBank = new Set<string>();
  const results: Array<{ feedAccountId: string; bankAccountId: string; created: boolean }> = [];
  let newlyMapped = 0;

  for (const mapping of input.mappings) {
    const feed = feedAccounts.find((a) => a.providerAccountId === mapping.feedAccountId);
    if (!feed) throw new FeedServiceError('bad_request', `Feed account '${mapping.feedAccountId}' is not on this connection`);
    if (seenFeed.has(feed.providerAccountId)) throw new FeedServiceError('bad_request', `Feed account '${feed.providerAccountId}' is mapped twice`);
    seenFeed.add(feed.providerAccountId);
    if (!mapping.bankAccountId && !mapping.create) throw new FeedServiceError('bad_request', 'Each mapping needs bankAccountId or create');

    const syncFrom = mapping.syncFrom ?? input.syncFrom ?? null;
    const feedColumns = {
      feedConnectionId: row.id,
      feedProvider: row.provider,
      feedAccountId: feed.providerAccountId,
      feedAccountFingerprint: feed.fingerprint,
      feedSyncFrom: syncFrom,
      feedStatus: feed.status,
      updatedAt: timestamp,
    };

    if (mapping.bankAccountId) {
      if (seenBank.has(mapping.bankAccountId)) throw new FeedServiceError('bad_request', `Bank account '${mapping.bankAccountId}' is mapped twice`);
      seenBank.add(mapping.bankAccountId);

      const [bank] = await ctx.db
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, mapping.bankAccountId), eq(bankAccounts.entityId, row.entityId), isNull(bankAccounts.deletedAt)))
        .limit(1);
      if (!bank) throw new FeedServiceError('not_found', `Bank account '${mapping.bankAccountId}' not found`);

      const takenElsewhere =
        bank.feedConnectionId && bank.feedConnectionId !== row.id && bank.feedStatus !== 'disconnected' && bank.feedStatus !== 'revoked';
      if (takenElsewhere) throw new FeedServiceError('conflict', `Bank account '${bank.name}' is already linked to another bank connection`);

      const alreadyThisFeed = bank.feedConnectionId === row.id && bank.feedAccountId === feed.providerAccountId;
      await ctx.db
        .update(bankAccounts)
        .set({
          ...feedColumns,
          accountType: bank.accountType ?? defaultAccountType(feed),
          accountNumberLast4: bank.accountNumberLast4 ?? lastFour(feed.mask),
          iban: bank.iban ?? (feed.iban ? normalizeIban(feed.iban).slice(0, 34) : null),
          bankName: bank.bankName ?? row.institutionName,
          isActive: true,
        })
        .where(eq(bankAccounts.id, bank.id));
      results.push({ feedAccountId: feed.providerAccountId, bankAccountId: bank.id, created: false });
      if (!alreadyThisFeed) newlyMapped += 1;
      continue;
    }

    const create = mapping.create;
    if (!create) continue;
    const accountType = create.accountType ?? defaultAccountType(feed);
    if (create.ledgerAccountId) {
      const [ledger] = await ctx.db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, create.ledgerAccountId), eq(schema.accounts.entityId, row.entityId), isNull(schema.accounts.deletedAt)))
        .limit(1);
      if (!ledger) throw new FeedServiceError('bad_request', `Ledger account '${create.ledgerAccountId}' not found on this entity`);
    }
    const ledgerAccountId =
      create.ledgerAccountId ??
      (await createLedgerAccountForBank(ctx.db, { entityId: row.entityId, name: create.name, accountType, currency: feed.currency }));
    const id = generateId('ba');
    const existingDefault = await ctx.db
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.entityId, row.entityId), eq(bankAccounts.isDefault, true), isNull(bankAccounts.deletedAt)))
      .limit(1);
    await ctx.db.insert(bankAccounts).values({
      id,
      entityId: row.entityId,
      name: create.name,
      bankName: row.institutionName,
      iban: feed.iban ? normalizeIban(feed.iban).slice(0, 34) : null,
      currency: feed.currency,
      ledgerAccountId,
      currentBalance: '0',
      isDefault: existingDefault.length === 0,
      isActive: true,
      autoReconcile: true,
      accountType,
      accountNumberLast4: lastFour(feed.mask),
      createdAt: timestamp,
      ...feedColumns,
    });
    seenBank.add(id);
    results.push({ feedAccountId: feed.providerAccountId, bankAccountId: id, created: true });
    newlyMapped += 1;
  }

  if (newlyMapped > 0) {
    // A newly mapped account has no history yet: read the connection from the start (writes are idempotent).
    await ctx.db
      .update(connections)
      .set({
        syncCursor: null,
        // A sync that is reading right now skipped these accounts; it keeps the cursor reset when it ends.
        metadata: sql`(coalesce(${connections.metadata}, '{}'::jsonb) || ${JSON.stringify({ resyncAt: timestamp.toISOString() })}::jsonb)`,
        updatedAt: timestamp,
      })
      .where(eq(connections.id, row.id));
  }

  return { view: await connectionViewById(ctx, row.id), mapped: results, needsSync: newlyMapped > 0 };
}

// ── Disconnect ─────────────────────────────────────────────────────────────

async function revokeAtProvider(ctx: FeedContext, row: ConnectionRow): Promise<void> {
  if (row.status === 'disconnected' || !row.credentialsEncrypted) return;
  let provider;
  try {
    provider = ctx.getProvider(row.provider);
  } catch {
    // Provider not configured here any more: nothing we can call; the local state still ends.
    return;
  }
  const stored = await toStoredConnection(
    ctx,
    row,
    storedFeedAccounts(row).map((a) => a.providerAccountId),
  );
  try {
    await provider.disconnect(stored);
  } catch (err) {
    // The consent is already gone on the provider's side; anything else the user can retry.
    const kind = (err as { kind?: string }).kind;
    if (kind === 'reauth_required' || kind === 'revoked' || kind === 'permanent') return;
    throw translateProviderError(err) ?? err;
  }
}

/** Revoke at the provider, keep every synced transaction, and stop syncing. */
export async function disconnectConnection(ctx: FeedContext, connectionId: string, entityId?: string | null): Promise<ConnectionView> {
  const row = await requireConnection(ctx.db, connectionId, entityId);
  await revokeAtProvider(ctx, row);
  const timestamp = now(ctx);

  const feedAccounts = storedFeedAccounts(row).map((a) => ({ ...a, status: 'disconnected' as ConnectionStatus }));
  await ctx.db
    .update(connections)
    .set({
      status: 'disconnected',
      credentialsEncrypted: null,
      lastError: null,
      metadata: { ...((row.metadata as Record<string, unknown> | null) ?? {}), feedAccounts },
      updatedAt: timestamp,
    })
    .where(eq(connections.id, row.id));
  await ctx.db
    .update(bankAccounts)
    .set({ feedStatus: 'disconnected', updatedAt: timestamp })
    .where(and(eq(bankAccounts.feedConnectionId, row.id), isNull(bankAccounts.deletedAt)));
  await ctx.index.setActive(row.id, false, null);
  return connectionViewById(ctx, row.id);
}

/** Disconnect, then drop the connection. Bank accounts keep their transactions and can be linked again. */
export async function deleteConnection(ctx: FeedContext, connectionId: string, entityId?: string | null): Promise<ConnectionRow> {
  const row = await requireConnection(ctx.db, connectionId, entityId);
  await revokeAtProvider(ctx, row);
  const timestamp = now(ctx);

  await ctx.db
    .update(bankAccounts)
    .set({ feedConnectionId: null, feedAccountId: null, feedStatus: null, updatedAt: timestamp })
    .where(and(eq(bankAccounts.feedConnectionId, row.id), isNull(bankAccounts.deletedAt)));
  await ctx.db
    .update(connections)
    .set({ status: 'disconnected', credentialsEncrypted: null, deletedAt: timestamp, updatedAt: timestamp })
    .where(eq(connections.id, row.id));
  await ctx.index.remove(row.id);
  return row;
}

// ── Pending ────────────────────────────────────────────────────────────────

export async function listPendingTransactions(db: Database, connectionId: string, bankAccountId?: string | null) {
  const pending = schema.bankFeedPendingTransactions;
  const rows = await db
    .select()
    .from(pending)
    .where(
      and(
        eq(pending.connectionId, connectionId),
        isNull(pending.voidedAt),
        bankAccountId ? eq(pending.bankAccountId, bankAccountId) : sql`true`,
      ),
    )
    .orderBy(desc(pending.date))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    bankAccountId: r.bankAccountId,
    date: r.date,
    amount: r.amount,
    currency: r.currency,
    description: r.description,
    merchantName: r.merchantName,
  }));
}

/** Status of a connection from its feed accounts' statuses. */
export function rollUpAccountStatuses(accounts: Array<{ status: ConnectionStatus }>): ConnectionStatus {
  return connectionStatus(accounts.map((a) => a.status));
}
