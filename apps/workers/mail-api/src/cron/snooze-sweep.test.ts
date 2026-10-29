import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createFakeMailboxNamespace, createFakeMailIndexEnv } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { createFixedModeFlagship } from '@weldsuite/mail-domain/store/testing/object-mode';

const tenantDbFor = vi.fn(async (_env: unknown, orgId: string) => ({ orgId }));
const mailWorkspaces = vi.fn(async () => [{ clerkOrgId: 'org_a' }, { clerkOrgId: 'org_b' }]);

// Every other export (`schema`, and everything `@weldsuite/mail-domain/store`
// pulls in transitively through it — `store/directory.ts` reads real columns
// off `schema.mailAccounts`/`mailLabels` at import time) comes from the real
// module: a hand-rolled partial `schema` throws before any test body runs
// (see `getWorkspaceMail`'s own cron/route callers for the same lesson).
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: (env: unknown, orgId: string) => tenantDbFor(env, orgId),
    // `runSnoozeSweep` resolves the internal workspace id to check the
    // mailbox-store mode (design task D2) — this test never binds FLAGSHIP,
    // so every workspace resolves to `postgres` regardless of this id.
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => ({ id: `ws_${orgId}`, clerkOrgId: orgId }),
    getMasterDb: () => ({
      selectDistinct: () => ({ from: () => ({ innerJoin: () => ({ where: () => mailWorkspaces() }) }) }),
    }),
    masterSchema: {
      mailAccountRegistry: { workspaceId: 'workspace_id', tenantKind: 'tenant_kind', isActive: 'is_active' },
      workspaces: { id: 'id', clerkOrgId: 'clerk_org_id', isActive: 'is_active' },
    },
  };
});

const woken = new Map<string, number>();
const nextDue = new Map<string, Date | null>();
vi.mock('@weldsuite/mail-domain/snooze', () => ({
  wakeDueSnoozedMessages: vi.fn(async (db: { orgId: string }) => ({ woken: woken.get(db.orgId) ?? 0, accountIds: [] })),
  nextSnoozeDueAt: vi.fn(async (db: { orgId: string }) => nextDue.get(db.orgId) ?? null),
}));

import { isSnoozeSweepCron, runSnoozeSweep, SNOOZE_INDEX_SEED_KEY, SNOOZE_SWEEP_CRONS } from './snooze-sweep';

const MIGRATION = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql',
  ),
  'utf8',
);

const T0 = new Date(Date.UTC(2026, 9, 8, 9, 0, 0));
const HOUR = 3_600_000;

function makeEnv(seeded: boolean) {
  const kv = createMemoryKv();
  if (seeded) kv.store.set(SNOOZE_INDEX_SEED_KEY, 'done');
  return { SCHEDULE_INDEX: createSqliteD1(MIGRATION), WORKSPACE_CACHE: kv };
}

describe('isSnoozeSweepCron', () => {
  it('runs on the 5-minute cadence only', () => {
    expect(SNOOZE_SWEEP_CRONS).toEqual(['*/5 * * * *']);
    expect(isSnoozeSweepCron('*/5 * * * *')).toBe(true);
    expect(isSnoozeSweepCron('0 * * * *')).toBe(false);
    expect(isSnoozeSweepCron('* * * * *')).toBe(false);
  });
});

describe('runSnoozeSweep', () => {
  beforeEach(() => {
    tenantDbFor.mockClear();
    mailWorkspaces.mockClear();
    woken.clear();
    nextDue.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('opens no tenant and no master DB on a quiet tick', async () => {
    const env = makeEnv(true);
    const res = await runSnoozeSweep(env as never, T0);
    expect(res).toMatchObject({ due: 0, processed: 0, woken: 0 });
    expect(tenantDbFor).not.toHaveBeenCalled();
    expect(mailWorkspaces).not.toHaveBeenCalled();
  });

  it('opens only workspaces whose snooze is due, then waits for their next one', async () => {
    const env = makeEnv(true);
    await markWorkspaceDue(env.SCHEDULE_INDEX, 'mail_snooze', 'org_due', T0.getTime() - 1);
    await markWorkspaceDue(env.SCHEDULE_INDEX, 'mail_snooze', 'org_later', T0.getTime() + HOUR);
    woken.set('org_due', 3);
    nextDue.set('org_due', new Date(T0.getTime() + 2 * HOUR));

    const res = await runSnoozeSweep(env as never, T0);
    expect(res).toMatchObject({ due: 1, processed: 1, woken: 3 });
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    expect(tenantDbFor).toHaveBeenCalledWith(env, 'org_due');

    // Nothing is due until org_later's snooze an hour from now.
    tenantDbFor.mockClear();
    await runSnoozeSweep(env as never, new Date(T0.getTime() + 30 * 60_000));
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('seeds every mailbox workspace once, then drops the ones with nothing snoozed', async () => {
    const env = makeEnv(false);
    nextDue.set('org_a', new Date(T0.getTime() + HOUR));

    const first = await runSnoozeSweep(env as never, T0);
    expect(first).toMatchObject({ seeded: 2, due: 2, processed: 2 });
    expect(env.WORKSPACE_CACHE.store.has(SNOOZE_INDEX_SEED_KEY)).toBe(true);

    tenantDbFor.mockClear();
    await runSnoozeSweep(env as never, new Date(T0.getTime() + HOUR));
    expect(mailWorkspaces).toHaveBeenCalledTimes(1);
    expect(tenantDbFor.mock.calls.map(([, orgId]) => orgId)).toEqual(['org_a']);
  });

  // design task D2: an `object`-mode workspace wakes each of its mailboxes
  // through the store's `snooze.wake` op instead of the single cross-mailbox
  // Postgres UPDATE — still only for the workspace the D1 due index lists.
  it('wakes an object-mode workspace through the store, per mailbox', async () => {
    const orgId = 'org_obj';
    const workspaceId = `ws_${orgId}`;
    const db = (await createPgliteDb()).db;
    const accountId = generateId('mail');
    await db.insert(schema.mailAccounts).values({ id: accountId, name: 'Obj', email: `${accountId}@test.dev`, isShared: true });

    tenantDbFor.mockImplementationOnce(async () => db as unknown as { orgId: string });

    const mailbox = createFakeMailboxNamespace();
    const mailIndex = createFakeMailIndexEnv();
    const env = {
      ...makeEnv(true),
      FLAGSHIP: createFixedModeFlagship('object'),
      MAILBOX_STORE: mailbox.namespace,
      ...mailIndex,
      MAIL_STORAGE: {},
    };

    // Ingest a message into the fake mailbox object directly, then snooze it
    // so it's due — the object is the source of truth for its own mailbox in
    // `object` mode, so there is nothing to wake on the Postgres side at all.
    const ref = { workspaceId, accountId, clerkOrgId: orgId };
    const ns = mailbox.namespace.jurisdiction('eu');
    const stub = ns.get(ns.idFromName(`mbx:${workspaceId}:${accountId}`));
    const messageId = generateId('mmsg');
    await stub.apply(ref, {
      kind: 'ingest',
      message: {
        id: messageId,
        source: 'inbound',
        rfcMessageId: `<${messageId}@test.dev>`,
        threadId: null,
        from: { email: 'sender@example.com' },
        to: [{ email: 'me@test.dev' }],
        subject: 'Due snooze',
        preview: null,
        sentAt: T0.getTime() - HOUR,
        receivedAt: T0.getTime() - HOUR,
        createdAt: T0.getTime() - HOUR,
        isRead: false,
        labels: ['INBOX'],
        isSpam: false,
        isReply: false,
        attachments: [],
      },
    }, T0.getTime() - HOUR);
    await stub.apply(ref, { kind: 'snooze', id: messageId, until: T0.getTime() - 1 }, T0.getTime() - HOUR);

    await markWorkspaceDue(env.SCHEDULE_INDEX, 'mail_snooze', orgId, T0.getTime() - 1);

    const res = await runSnoozeSweep(env as never, T0);
    expect(res).toMatchObject({ due: 1, processed: 1, woken: 1 });
  }, 30_000);
});
