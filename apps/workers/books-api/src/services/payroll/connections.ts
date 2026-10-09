/**
 * Payroll provider connections (Gusto) and the sync that turns each processed
 * payroll into one journal entry.
 *
 * The access token is stored encrypted (`credentialsEncrypted`, with the
 * workers' DATABASE_ENCRYPTION_KEY) as `{ accessToken, environment }` and is
 * never returned or put on an entity event. The `csv` pseudo connection of an
 * entity holds its saved CSV mapping (see mapping.ts) and has no credentials.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import { loadEntityAccounts } from '../accounting-posting';
import { isPayrollFailure } from './errors';
import {
  fetchGustoCompany,
  fetchProcessedPayrolls,
  normalizeGustoPayroll,
  type GustoCredentials,
  type GustoEnvironment,
} from './gusto';
import { DuplicatePayrollError, findImportByExternalId, postPayrollImport } from './imports';
import { PayrollImportError, buildPayrollLines, summaryOf } from './journal';
import { accountMappingSchema, expandCsvMapping, flattenCsvMapping, type AccountMapping, type CsvMapping } from './mapping';

const connections = schema.payrollConnections;

export type ConnectionRow = typeof connections.$inferSelect;

/** A connection as the API shows it: no ciphertext, plus what is safe to say about the credentials. */
export type PublicConnection = Omit<ConnectionRow, 'credentialsEncrypted'> & {
  hasCredentials: boolean;
  environment: GustoEnvironment | null;
};

export async function publicConnection(row: ConnectionRow, keyring: EncryptionKeyring): Promise<PublicConnection> {
  let environment: GustoEnvironment | null = null;
  if (row.credentialsEncrypted) {
    try {
      environment = parseCredentials(await decryptField(row.credentialsEncrypted, keyring)).environment;
    } catch {
      environment = null;
    }
  }
  return { ...omitSensitive('payroll_connections', row), hasCredentials: Boolean(row.credentialsEncrypted), environment };
}

function parseCredentials(plain: string): GustoCredentials {
  const parsed = JSON.parse(plain) as Partial<GustoCredentials>;
  if (!parsed.accessToken) throw new PayrollImportError('The stored Gusto credentials are unreadable; reconnect Gusto');
  return { accessToken: parsed.accessToken, environment: parsed.environment === 'demo' ? 'demo' : 'production' };
}

export async function loadConnection(db: Database, id: string): Promise<ConnectionRow | null> {
  const [row] = await db.select().from(connections).where(and(eq(connections.id, id), isNull(connections.deletedAt))).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Gusto connection

export async function createGustoConnection(
  db: Database,
  args: {
    entityId: string;
    accessToken: string;
    companyId: string;
    environment: GustoEnvironment;
    accountMapping?: AccountMapping;
    keyring: EncryptionKeyring;
  },
): Promise<ConnectionRow> {
  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.entityId, args.entityId),
        eq(connections.provider, 'gusto'),
        eq(connections.providerCompanyId, args.companyId),
        isNull(connections.deletedAt),
      ),
    )
    .limit(1);
  if (existing) throw new PayrollImportError('This Gusto company is already connected to this accounting entity');

  const credentials: GustoCredentials = { accessToken: args.accessToken, environment: args.environment };
  // Verifies the token and the company id before anything is stored.
  await fetchGustoCompany(credentials, args.companyId);
  if (args.accountMapping) await assertMappingAccounts(db, args.entityId, args.accountMapping);

  const now = new Date();
  const row: ConnectionRow = {
    id: generateId('prc'),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    entityId: args.entityId,
    provider: 'gusto',
    providerCompanyId: args.companyId,
    credentialsEncrypted: await encryptField(JSON.stringify(credentials), args.keyring),
    accountMapping: args.accountMapping ?? null,
    status: 'active',
    lastSyncedAt: null,
    lastError: null,
  };
  await db.insert(connections).values(row);
  return row;
}

export async function assertMappingAccounts(db: Database, entityId: string, mapping: AccountMapping): Promise<void> {
  const parsed = accountMappingSchema.safeParse(mapping);
  if (!parsed.success) throw new PayrollImportError(parsed.error.issues[0]?.message ?? 'Invalid account mapping');
  const accounts = await loadEntityAccounts(db, entityId);
  for (const [category, accountId] of Object.entries(mapping)) {
    if (!accounts.byId(accountId)) throw new PayrollImportError(`The account mapped to ${category} does not belong to this accounting entity`);
  }
}

export async function setAccountMapping(db: Database, connection: ConnectionRow, mapping: AccountMapping): Promise<ConnectionRow> {
  await assertMappingAccounts(db, connection.entityId, mapping);
  const now = new Date();
  await db.update(connections).set({ accountMapping: mapping, updatedAt: now }).where(eq(connections.id, connection.id));
  return { ...connection, accountMapping: mapping, updatedAt: now };
}

export async function disconnect(db: Database, connection: ConnectionRow): Promise<void> {
  const now = new Date();
  await db
    .update(connections)
    .set({ deletedAt: now, status: 'disconnected', credentialsEncrypted: null, updatedAt: now })
    .where(eq(connections.id, connection.id));
}

// ---------------------------------------------------------------------------
// Saved CSV mapping (the `csv` pseudo connection)

export async function loadCsvConnection(db: Database, entityId: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.entityId, entityId), eq(connections.provider, 'csv'), isNull(connections.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function loadSavedCsvMapping(db: Database, entityId: string): Promise<CsvMapping | null> {
  const row = await loadCsvConnection(db, entityId);
  return expandCsvMapping(row?.accountMapping);
}

export async function saveCsvMapping(
  db: Database,
  entityId: string,
  mapping: CsvMapping,
): Promise<{ row: ConnectionRow; created: boolean }> {
  await assertCsvMappingAccounts(db, entityId, mapping);
  const flat = flattenCsvMapping(mapping);
  const now = new Date();
  const existing = await loadCsvConnection(db, entityId);
  if (existing) {
    await db.update(connections).set({ accountMapping: flat, updatedAt: now }).where(eq(connections.id, existing.id));
    return { row: { ...existing, accountMapping: flat, updatedAt: now }, created: false };
  }
  const row: ConnectionRow = {
    id: generateId('prc'),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    entityId,
    provider: 'csv',
    providerCompanyId: null,
    credentialsEncrypted: null,
    accountMapping: flat,
    status: 'active',
    lastSyncedAt: null,
    lastError: null,
  };
  await db.insert(connections).values(row);
  return { row, created: true };
}

export async function assertCsvMappingAccounts(db: Database, entityId: string, mapping: CsvMapping): Promise<void> {
  if (mapping.shape === 'summary') {
    await assertMappingAccounts(db, entityId, mapping.accounts);
    return;
  }
  const accounts = await loadEntityAccounts(db, entityId);
  for (const [label, accountId] of Object.entries(mapping.accounts)) {
    if (!accounts.byId(accountId)) throw new PayrollImportError(`The account mapped to "${label}" does not belong to this accounting entity`);
  }
}

// ---------------------------------------------------------------------------
// Sync

export interface SyncArgs {
  entityId: string;
  connection: ConnectionRow;
  userId: string | null;
  keyring: EncryptionKeyring;
  /** Check dates, YYYY-MM-DD. Default: from 30 days before the last sync (or the start of the year) to today. */
  from?: string;
  to?: string;
  today: string;
  fetchImpl?: Parameters<typeof fetchProcessedPayrolls>[3];
}

export interface SyncResult {
  from: string;
  to: string;
  fetched: number;
  imported: Array<{ externalId: string; payDate: string; importId: string; journalEntryId: string }>;
  skipped: Array<{ externalId: string | null; payDate: string | null; reason: string }>;
  failed: Array<{ externalId: string; payDate: string; error: string }>;
}

function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** Windows of at most one year, since Gusto limits how wide a payroll query can be. */
function windows(from: string, to: string): Array<{ from: string; to: string }> {
  const result: Array<{ from: string; to: string }> = [];
  let start = from;
  while (start <= to) {
    const next = daysBefore(`${Number(start.slice(0, 4)) + 1}${start.slice(4)}`, 1);
    const end = next < to ? next : to;
    result.push({ from: start, to: end });
    start = new Date(new Date(`${end}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  }
  return result;
}

export async function syncGustoConnection(db: Database, args: SyncArgs): Promise<SyncResult> {
  const { connection } = args;
  if (connection.provider !== 'gusto') throw new PayrollImportError('Only Gusto connections can sync');
  if (!connection.credentialsEncrypted || !connection.providerCompanyId) throw new PayrollImportError('The Gusto connection has no credentials; reconnect it');
  const mapping = connection.accountMapping ?? {};
  if (!mapping.net_pay) {
    throw new PayrollImportError('Map the net pay account first (PUT /api/payroll/connections/:id/mapping with at least net_pay)');
  }
  const credentials = parseCredentials(await decryptField(connection.credentialsEncrypted, args.keyring));
  const to = args.to ?? args.today;
  const from =
    args.from ??
    (connection.lastSyncedAt ? daysBefore(connection.lastSyncedAt.toISOString().slice(0, 10), 30) : `${args.today.slice(0, 4)}-01-01`);
  if (from > to) throw new PayrollImportError('from must not be after to');

  const accounts = await loadEntityAccounts(db, args.entityId);
  const result: SyncResult = { from, to, fetched: 0, imported: [], skipped: [], failed: [] };

  let payrolls: unknown[] = [];
  try {
    for (const window of windows(from, to)) {
      payrolls = payrolls.concat(await fetchProcessedPayrolls(credentials, connection.providerCompanyId, window, args.fetchImpl));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(connections).set({ status: 'error', lastError: message, updatedAt: new Date() }).where(eq(connections.id, connection.id));
    throw err;
  }
  result.fetched = payrolls.length;

  for (const raw of payrolls) {
    const payroll = normalizeGustoPayroll(raw);
    if ('skip' in payroll) {
      result.skipped.push({ externalId: payroll.externalId, payDate: null, reason: payroll.skip });
      continue;
    }
    const existing = await findImportByExternalId(db, args.entityId, 'gusto', payroll.externalId);
    if (existing) {
      result.skipped.push({
        externalId: payroll.externalId,
        payDate: payroll.payDate,
        reason: existing.status === 'reversed' ? 'Already imported and reversed' : 'Already imported',
      });
      continue;
    }
    try {
      const lines = buildPayrollLines(payroll.totals, accounts, mapping, `Gusto payroll ${payroll.payDate}`);
      const posted = await postPayrollImport(db, {
        entityId: args.entityId,
        userId: args.userId,
        source: 'gusto',
        connectionId: connection.id,
        externalId: payroll.externalId,
        payDate: payroll.payDate,
        periodStart: payroll.periodStart,
        periodEnd: payroll.periodEnd,
        lines,
        summary: summaryOf(payroll.totals),
        description: `Gusto payroll ${payroll.payDate}${payroll.offCycle ? ' (off-cycle)' : ''}`,
      });
      result.imported.push({ externalId: payroll.externalId, payDate: payroll.payDate, importId: posted.importId, journalEntryId: posted.journalEntryId });
    } catch (err) {
      if (err instanceof DuplicatePayrollError) {
        result.skipped.push({ externalId: payroll.externalId, payDate: payroll.payDate, reason: 'Already imported' });
      } else if (isPayrollFailure(err)) {
        result.failed.push({ externalId: payroll.externalId, payDate: payroll.payDate, error: err.message });
      } else {
        throw err;
      }
    }
  }

  await db
    .update(connections)
    .set({
      status: result.failed.length > 0 && result.imported.length === 0 ? 'error' : 'active',
      lastSyncedAt: new Date(),
      lastError: result.failed.length > 0 ? `${result.failed.length} payroll(s) could not be imported: ${result.failed[0]!.error}` : null,
      updatedAt: new Date(),
    })
    .where(eq(connections.id, connection.id));
  return result;
}
