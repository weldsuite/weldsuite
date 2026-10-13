/** Seeds, fakes and helpers shared by the worker's tests (pglite master DB). */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import { sealWarmupCredentials } from '@weldsuite/reach-domain/warmup-pool';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { FlagshipBinding } from '@weldsuite/feature-flags/server';
import { ImapError, type ImapSession } from '@weldsuite/imap';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import type { Env } from '../env';

export const pool = masterSchema.reachWarmupMailboxes;
export const messages = masterSchema.reachWarmupMessages;

export type NewMailbox = typeof pool.$inferInsert;
export type NewMessage = typeof messages.$inferInsert;

export const WARMUP_KEY = 'cd'.repeat(32);

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'test', DATABASE_URL_MASTER: 'unused', WELDREACH_WARMUP_KEY: WARMUP_KEY, ...overrides };
}

export function flagship(enabled: boolean): FlagshipBinding {
  return {
    getBooleanValue: vi.fn(async () => enabled),
    getStringValue: vi.fn(async (_key: string, fallback: string) => fallback),
    getNumberValue: vi.fn(async (_key: string, fallback: number) => fallback),
    getObjectValue: vi.fn(async (_key: string, fallback: unknown) => fallback),
  } as unknown as FlagshipBinding;
}

export async function resetMaster(master: MasterDatabase): Promise<void> {
  await master.delete(messages);
  await master.delete(pool);
}

export interface MailboxSeed extends Partial<NewMailbox> {
  id: string;
  domain?: string;
}

/** A pool mailbox with real sealed logins (smtp.test:465, imap.test:993, password "pw"). */
export async function seedMailbox(master: MasterDatabase, seed: MailboxSeed): Promise<string> {
  const domain = seed.domain ?? `${seed.id}.test`;
  const email = seed.email ?? `${seed.id}@${domain}`;
  const smtp = { host: 'smtp.test', port: 465, tls: true, username: email, password: 'pw' };
  const imap = { host: 'imap.test', port: 993, tls: true, username: email, password: 'pw' };
  await master.insert(pool).values({
    workspaceId: 'ws_1',
    clerkOrgId: `org_${seed.id}`,
    tenantMailboxId: `tm_${seed.id}`,
    mailboxType: 'google',
    firstName: seed.id.slice(0, 1).toUpperCase() + seed.id.slice(1),
    lastName: 'Tester',
    timezone: 'UTC',
    status: 'warming',
    rampDay: 1,
    smtpCredentials: await sealWarmupCredentials({ WELDREACH_WARMUP_KEY: WARMUP_KEY }, smtp),
    imapCredentials: await sealWarmupCredentials({ WELDREACH_WARMUP_KEY: WARMUP_KEY }, imap),
    ...seed,
    domain,
    email,
  });
  return seed.id;
}

export interface MessageSeed extends Partial<NewMessage> {
  id: string;
  fromMailboxId: string;
  toMailboxId: string;
}

export async function seedMessage(master: MasterDatabase, seed: MessageSeed): Promise<string> {
  await master.insert(messages).values({
    threadId: `th_${seed.id}`,
    step: 0,
    corpusThreadId: 'stub-001',
    messageIdHeader: `${seed.id}@${seed.fromMailboxId}.test`,
    subject: 'Quarterly planning',
    status: 'scheduled',
    scheduledAt: new Date('2026-10-12T09:00:00Z'),
    ...seed,
  });
  return seed.id;
}

export interface FakeQueueMessage<T> {
  body: T;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

export interface FakeBatch<T> {
  queue: string;
  messages: FakeQueueMessage<T>[];
  ackAll: ReturnType<typeof vi.fn>;
  retryAll: ReturnType<typeof vi.fn>;
}

export function fakeBatch<T>(queue: string, bodies: T[]): FakeBatch<T> {
  return {
    queue,
    messages: bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() })),
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

export const FAKE_CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

/** Deterministic uniform [0, 1) generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const constant = (value: number) => () => value;

// ---------------------------------------------------------------------------
// A scripted IMAP account
// ---------------------------------------------------------------------------

export interface FakeImapMessage {
  uid: number;
  messageId: string;
  flags: Set<string>;
}

export interface FakeImapOptions {
  folders?: Record<string, FakeImapMessage[]>;
  /** SPECIAL-USE map, e.g. `{ '\\Junk': 'Spam' }`. */
  special?: Record<string, string>;
}

/** An in-memory mailbox implementing the parts of ImapSession the worker uses. */
export class FakeImapAccount {
  readonly folders: Record<string, FakeImapMessage[]>;
  readonly special: Record<string, string>;
  readonly calls: string[] = [];
  loggedOut = false;
  private selected = 'INBOX';
  private nextUid = 1000;

  constructor(options: FakeImapOptions = {}) {
    this.folders = { INBOX: [], ...(options.folders ?? {}) };
    this.special = options.special ?? {};
  }

  put(folder: string, messageId: string, flags: string[] = []): FakeImapMessage {
    const message = { uid: this.nextUid++, messageId, flags: new Set(flags) };
    const list = this.folders[folder] ?? [];
    list.push(message);
    this.folders[folder] = list;
    return message;
  }

  find(messageId: string): { folder: string; message: FakeImapMessage } | null {
    for (const [folder, list] of Object.entries(this.folders)) {
      const message = list.find((m) => m.messageId === messageId);
      if (message) return { folder, message };
    }
    return null;
  }

  session(): ImapSession {
    const account = this;
    return {
      capabilities: new Set(['MOVE']),
      async listMailboxes() {
        return [];
      },
      async findSpecialUse(use) {
        account.calls.push(`findSpecialUse ${use}`);
        return account.special[use] ?? null;
      },
      async select(mailbox) {
        account.calls.push(`select ${mailbox}`);
        account.selected = mailbox;
        return { exists: account.folders[mailbox]?.length ?? 0, uidValidity: 1 };
      },
      async searchByMessageId(messageId) {
        account.calls.push(`search ${messageId}`);
        return (account.folders[account.selected] ?? []).filter((m) => m.messageId === messageId).map((m) => m.uid);
      },
      async addFlags(uids, flags) {
        account.calls.push(`addFlags ${flags.join(',')}`);
        for (const m of account.folders[account.selected] ?? []) {
          if (uids.includes(m.uid)) for (const flag of flags) m.flags.add(flag);
        }
      },
      async move(uids, destination) {
        account.calls.push(`move ${destination}`);
        const source = account.folders[account.selected] ?? [];
        const moving = source.filter((m) => uids.includes(m.uid));
        account.folders[account.selected] = source.filter((m) => !uids.includes(m.uid));
        for (const m of moving) account.put(destination, m.messageId, [...m.flags]);
      },
      async deleteMessages(uids) {
        account.calls.push(`delete ${account.selected}`);
        account.folders[account.selected] = (account.folders[account.selected] ?? []).filter((m) => !uids.includes(m.uid));
      },
      async logout() {
        account.loggedOut = true;
      },
    };
  }
}

/** Returns the values in order, then the last one forever. */
export function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

// ---------------------------------------------------------------------------
// D1 due index (the schedule index reach-api's warmup sweep reads)
// ---------------------------------------------------------------------------

export function createDueIndex(): D1Database {
  const migration = readFileSync(
    resolve(__dirname, '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
    'utf8',
  );
  return createSqliteD1(migration);
}

/** next_due_at of the reach_warmup row of a workspace, or null when it was never marked. */
export async function dueAt(d1: D1Database, clerkOrgId: string): Promise<number | null> {
  return d1
    .prepare("SELECT next_due_at FROM workspace_due_index WHERE kind = 'reach_warmup' AND workspace_id = ?")
    .bind(clerkOrgId)
    .first<number>('next_due_at');
}

// ---------------------------------------------------------------------------
// Routing connectImap to scripted accounts
// ---------------------------------------------------------------------------

/**
 * Make a mocked `connectImap` hand out the account of the login's username, or
 * throw the error registered for it. An unknown username is a connect error.
 */
export function routeImap(
  connect: { mockImplementation(fn: (config: { username: string }) => Promise<ImapSession>): unknown },
  accounts: Record<string, FakeImapAccount | Error>,
): void {
  connect.mockImplementation(async (config) => {
    const account = accounts[config.username];
    if (!account) throw new ImapError('connect', `no route to ${config.username}`);
    if (account instanceof Error) throw account;
    return account.session();
  });
}
