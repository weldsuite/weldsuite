/**
 * `MailIndex`: one per workspace, name `mbxidx:<workspaces.id>`, always
 * reached through `env.MAIL_INDEX.jurisdiction('eu')` (`client.ts`). Holds
 * email addresses — correspondents and the address index — so it lives in its
 * own EU-jurisdiction object instead of the (non-EU) `OutboundLedger`
 * (design decision 1, docs/plans/weldmail-mailbox-store-design.md).
 *
 * This is the first SQLite-backed object in `@weldsuite/mail-domain`;
 * `OutboundLedger` (outbound/ledger.ts) only uses the KV half of
 * `ctx.storage`. Schema and migrations: `./sql.ts`. Built and tested like
 * `OutboundLedger`/the planned `MailboxObject`: `DurableObject` from
 * `cloudflare:workers`, migrations run once in the constructor inside
 * `blockConcurrencyWhile`, alarm-paged background work.
 *
 * mail-api re-exports this class once its `wrangler.toml` gains the
 * `MAIL_INDEX` binding and `new_sqlite_classes` migration (a later task, not
 * this one — see the worktree's task notes).
 */

import { DurableObject } from 'cloudflare:workers';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import { defaultCorrespondentsReader } from './correspondents-reader';
import {
  MAIL_INDEX_MIGRATIONS,
  UPSERT_ADDRESS_INDEX,
  UPSERT_INBOUND_CORRESPONDENT,
  UPSERT_OUTBOUND_CORRESPONDENT,
  UPSERT_SEED_CORRESPONDENT,
} from './sql';
import type {
  CorrespondentRow,
  CorrespondentsReader,
  FirstContactsResult,
  MailAddressBatchEntry,
  MailIndexModeHint,
  MailIndexSeedingState,
  MailIndexStatus,
  RecordMailAddressesResult,
} from './types';

export interface MailIndexEnv extends DbEnv {
  /** Test-only override; see `correspondents-reader.ts`'s file comment. */
  correspondentsReader?: CorrespondentsReader;
}

const SEED_PAGE_SIZE = 500;
const MAX_SEED_ATTEMPTS = 10;
const SEED_RETRY_BASE_MS = 5_000;

const IDLE_SEEDING: MailIndexSeedingState = {
  state: 'idle',
  source: null,
  cursor: null,
  startedAt: null,
  copied: 0,
  attempts: 0,
  lastError: null,
};

/** Lower-case, trimmed; defensive even though callers (guard.ts) already normalise. */
function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function backoffMs(attempts: number): number {
  return Math.min(SEED_RETRY_BASE_MS * 2 ** (attempts - 1), 60 * 60_000);
}

export class MailIndex extends DurableObject<MailIndexEnv> {
  constructor(ctx: DurableObjectState, env: MailIndexEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  // ---- schema ---------------------------------------------------------

  private migrate(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
    );
    let current = this.getMetaNumber('schema_version') ?? 0;
    for (const migration of MAIL_INDEX_MIGRATIONS) {
      if (migration.version <= current) continue;
      this.ctx.storage.transactionSync(() => {
        for (const statement of migration.statements) this.ctx.storage.sql.exec(statement);
        this.setMeta('schema_version', String(migration.version));
      });
      current = migration.version;
    }
  }

  // ---- meta helpers -----------------------------------------------------

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  private getMetaNumber(key: string): number | null {
    const value = this.getMeta(key);
    return value === null ? null : Number(value);
  }

  private getMetaJson<T>(key: string): T | null {
    const value = this.getMeta(key);
    return value === null ? null : (JSON.parse(value) as T);
  }

  private setMetaJson(key: string, value: unknown): void {
    this.setMeta(key, JSON.stringify(value));
  }

  private isSeeded(): boolean {
    return this.getMeta('seeded') === '1';
  }

  private setSeeded(value: boolean): void {
    this.setMeta('seeded', value ? '1' : '0');
  }

  private getSeedingState(): MailIndexSeedingState {
    return this.getMetaJson<MailIndexSeedingState>('seeding') ?? IDLE_SEEDING;
  }

  private setSeedingState(state: MailIndexSeedingState): void {
    this.setMetaJson('seeding', state);
  }

  /**
   * Every public method takes `workspaceId` first and is validated against
   * the object's bound workspace (set on first call) — defence in depth, since
   * the Durable Object's name (`mbxidx:<workspaceId>`) is just a hash input
   * and a caller bug could in principle address the wrong instance. Mirrors
   * `MailboxObject`'s planned `bindRef`.
   */
  private ensureWorkspace(workspaceId: string): void {
    const bound = this.getMeta('workspace_id');
    if (bound === null) {
      this.setMeta('workspace_id', workspaceId);
      return;
    }
    if (bound !== workspaceId) {
      throw new Error(`MailIndex: bound to workspace ${bound}, called with ${workspaceId}`);
    }
  }

  private countRows(table: 'correspondents' | 'address_index' | 'applied_messages'): number {
    const row = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one();
    return row.n;
  }

  // ---- RPC: writes --------------------------------------------------------

  async recordMailAddresses(workspaceId: string, entries: MailAddressBatchEntry[]): Promise<RecordMailAddressesResult> {
    this.ensureWorkspace(workspaceId);
    let applied = 0;
    let skipped = 0;
    this.ctx.storage.transactionSync(() => {
      for (const entry of entries) {
        const already = this.ctx.storage.sql
          .exec<{ message_id: string }>('SELECT message_id FROM applied_messages WHERE message_id = ?', entry.messageId)
          .toArray();
        if (already.length > 0) {
          skipped++;
          continue;
        }
        if (entry.from) {
          const from = normalizeAddress(entry.from);
          this.ctx.storage.sql.exec(UPSERT_INBOUND_CORRESPONDENT, from, entry.at, entry.at, entry.at);
        }
        const addresses = new Set(entry.addresses.map(normalizeAddress).filter((a) => a.includes('@')));
        for (const address of addresses) {
          this.ctx.storage.sql.exec(UPSERT_ADDRESS_INDEX, address, entry.accountId, entry.at);
        }
        this.ctx.storage.sql.exec(
          'INSERT INTO applied_messages (message_id, account_id, applied_at) VALUES (?, ?, ?)',
          entry.messageId,
          entry.accountId,
          entry.at,
        );
        applied++;
      }
    });
    return { applied, skipped };
  }

  /** The guard's post-send path: counts a successful send against each recipient's correspondent row. Not idempotent — called once per commit, like today's Postgres `recordOutboundCorrespondents`. */
  async recordOutbound(workspaceId: string, addresses: string[], at: number): Promise<void> {
    this.ensureWorkspace(workspaceId);
    const normalized = [...new Set(addresses.map(normalizeAddress).filter((a) => a.includes('@')))];
    if (normalized.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      for (const address of normalized) {
        this.ctx.storage.sql.exec(UPSERT_OUTBOUND_CORRESPONDENT, address, at, at, at);
      }
    });
  }

  async dropMailbox(workspaceId: string, accountId: string): Promise<void> {
    this.ensureWorkspace(workspaceId);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM address_index WHERE account_id = ?', accountId);
      this.ctx.storage.sql.exec('DELETE FROM applied_messages WHERE account_id = ?', accountId);
    });
  }

  /** Workspace deletion (design §7): wipe everything this object holds. */
  async forgetMailData(workspaceId: string): Promise<void> {
    this.ensureWorkspace(workspaceId);
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    // Leaves the object structurally valid if it is ever touched again
    // (it shouldn't be: the workspace is gone), same as a freshly created one.
    this.migrate();
  }

  // ---- RPC: reads -----------------------------------------------------

  async firstContacts(workspaceId: string, recipients: string[], mode: MailIndexModeHint): Promise<FirstContactsResult> {
    this.ensureWorkspace(workspaceId);
    const authoritative = mode === 'object-only' && this.isSeeded();
    if (recipients.length === 0) return { authoritative, firstContact: [] };
    const normalized = recipients.map(normalizeAddress);
    const placeholders = normalized.map(() => '?').join(',');
    const known = new Set(
      this.ctx.storage.sql
        .exec<{ email: string }>(
          `SELECT email FROM correspondents WHERE email IN (${placeholders}) AND first_inbound_at IS NOT NULL`,
          ...normalized,
        )
        .toArray()
        .map((row) => row.email),
    );
    const firstContact = recipients.filter((recipient) => !known.has(normalizeAddress(recipient)));
    return { authoritative, firstContact };
  }

  async mailboxesForAddress(workspaceId: string, address: string): Promise<string[]> {
    this.ensureWorkspace(workspaceId);
    const normalized = normalizeAddress(address);
    return this.ctx.storage.sql
      .exec<{ account_id: string }>(
        'SELECT account_id FROM address_index WHERE address = ? ORDER BY last_seen_at DESC',
        normalized,
      )
      .toArray()
      .map((row) => row.account_id);
  }

  async status(workspaceId: string): Promise<MailIndexStatus> {
    this.ensureWorkspace(workspaceId);
    return {
      seeded: this.isSeeded(),
      seeding: this.getSeedingState(),
      correspondentsCount: this.countRows('correspondents'),
      addressIndexCount: this.countRows('address_index'),
      appliedMessagesCount: this.countRows('applied_messages'),
      databaseSize: this.ctx.storage.sql.databaseSize,
    };
  }

  // ---- RPC: seeding -----------------------------------------------------

  /**
   * Starts (or reports) an alarm-paged copy of tenant Postgres
   * `mail_correspondents` into this object. A no-op while already `running`
   * or once `done`; call again after a `failed` state to retry.
   *
   * The object never opens Postgres mid-request here: the actual page reads
   * happen in `alarm()`, through `MailIndexEnv.correspondentsReader` (default:
   * `defaultCorrespondentsReader`, a direct tenant-DB read — the same
   * "DO's alarm opens the tenant DB itself" pattern the design doc uses for
   * `MailboxObject`'s backfill, §4). Tests inject a stub reader instead of a
   * real Postgres connection, which this environment (vitest's `node` runtime,
   * no network Postgres) can't provide.
   */
  async ensureCorrespondentsSeeded(workspaceId: string, source: string): Promise<MailIndexSeedingState> {
    this.ensureWorkspace(workspaceId);
    const current = this.getSeedingState();
    if (current.state === 'running' || current.state === 'done') return current;
    const next: MailIndexSeedingState = {
      state: 'running',
      source,
      cursor: null,
      startedAt: Date.now(),
      copied: 0,
      attempts: 0,
      lastError: null,
    };
    this.setSeedingState(next);
    await this.ctx.storage.setAlarm(Date.now());
    return next;
  }

  private applySeedPage(rows: CorrespondentRow[]): void {
    // `updated_at` has no Postgres source column on this row shape; stamping
    // "now" is safe because the seed upsert merges it with MAX(), so it only
    // ever moves this forward, never masks a more recent live write.
    const appliedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        this.ctx.storage.sql.exec(
          UPSERT_SEED_CORRESPONDENT,
          normalizeAddress(row.email),
          row.firstInboundAt,
          row.lastInboundAt,
          row.inboundCount,
          row.firstOutboundAt,
          row.lastOutboundAt,
          row.outboundCount,
          row.repliedAfterFirstContact ? 1 : 0,
          appliedAt,
        );
      }
    });
  }

  async alarm(): Promise<void> {
    const seeding = this.getSeedingState();
    if (seeding.state !== 'running') return;
    const workspaceId = this.getMeta('workspace_id');
    if (!workspaceId) {
      this.setSeedingState({ ...seeding, state: 'failed', lastError: 'MailIndex: no workspace bound yet' });
      return;
    }
    const reader = this.env.correspondentsReader ?? defaultCorrespondentsReader(this.env);
    try {
      const page = await reader(workspaceId, seeding.cursor, SEED_PAGE_SIZE);
      this.applySeedPage(page.rows);
      const copied = seeding.copied + page.rows.length;
      if (page.nextCursor === null) {
        this.setSeedingState({ ...seeding, state: 'done', cursor: null, copied, attempts: 0, lastError: null });
        this.setSeeded(true);
      } else {
        this.setSeedingState({ ...seeding, cursor: page.nextCursor, copied, attempts: 0, lastError: null });
        await this.ctx.storage.setAlarm(Date.now());
      }
    } catch (err) {
      const attempts = seeding.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_SEED_ATTEMPTS) {
        this.setSeedingState({ ...seeding, state: 'failed', attempts, lastError: message });
        console.error('[mail-index] seeding failed permanently:', message);
      } else {
        this.setSeedingState({ ...seeding, attempts, lastError: message });
        await this.ctx.storage.setAlarm(Date.now() + backoffMs(attempts));
      }
    }
  }
}
