/**
 * The lifecycle sweep against pglite (tenant + master) and an SQLite D1 due
 * index: requests past their expiry close (unless everyone signed), due
 * reminders go out once per interval up to the maximum, and the workspace's
 * next due time is stored.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { generateId } from '@weldsuite/worker-kit/id';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { memoryTransport } from '@weldsuite/emails/transports/memory';
import type { Env } from '../types';

const mail = vi.hoisted(() => ({ transport: null as ReturnType<typeof memoryTransport> | null }));
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: () => mail.transport }));
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>();
  return {
    ...actual,
    checkOutbound: vi.fn(async (_env: unknown, _db: unknown, input: { to: string[] }) => ({
      ledger: null,
      reservationId: null,
      sender: '',
      recipients: input.to,
      firstContact: [],
      mode: 'unavailable',
    })),
    commitOutbound: vi.fn(async () => undefined),
    releaseOutbound: vi.fn(async () => undefined),
  };
});
const dbs = vi.hoisted(() => ({ tenant: null as unknown, master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async () => dbs.tenant,
    getMasterDb: () => dbs.master,
    getWorkspaceForOrg: async () => ({ id: 'ws_sweep' }),
  };
});
const published = vi.hoisted(() => [] as Array<{ action: string; entityId: string }>);
vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEventRaw: vi.fn(async (e: { action: string; entityId: string }) => void published.push(e)) };
});

import { runLifecycleSweep } from './lifecycle-sweep';

const ORG = 'org_sweep';
const DAY = 86_400_000;
const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

let db: Database;
let master: MasterDatabase;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
}, 120_000);

beforeEach(() => {
  mail.transport = memoryTransport();
  published.length = 0;
});

async function request(id: string, values: Partial<typeof schema.signEnvelopes.$inferInsert>) {
  await db.insert(schema.signEnvelopes).values({
    id,
    title: `Request ${id}`,
    senderUserId: 'user_sender',
    senderName: 'Gert',
    senderEmail: 'gert@example.com',
    ...values,
  });
}

async function signer(envelopeId: string, name: string, values: Partial<typeof schema.signRecipients.$inferInsert>) {
  const id = generateId('sgr');
  await db.insert(schema.signRecipients).values({ id, envelopeId, role: 'signer', name, email: `${name.toLowerCase()}@example.com`, ...values });
  return id;
}

const recipient = async (id: string) => (await db.select().from(schema.signRecipients).where(eq(schema.signRecipients.id, id)))[0]!;
const envelope = async (id: string) => (await db.select().from(schema.signEnvelopes).where(eq(schema.signEnvelopes.id, id)))[0]!;

describe('lifecycle sweep', () => {
  it('expires, reminds once per interval up to the maximum, and stores the next due time', async () => {
    const now = new Date('2026-11-02T09:00:00Z');
    // A: Ann was emailed four days ago; first reminder after 3 days, then every 3, at most 2.
    await request('sgn_a', {
      status: 'sent',
      sentAt: new Date(now.getTime() - 4 * DAY),
      expiresAt: new Date(now.getTime() + 10 * DAY),
      reminderAfterDays: 3,
      reminderEveryDays: 3,
      reminderMaxCount: 2,
    });
    const ann = await signer('sgn_a', 'Ann', { status: 'sent', sentAt: new Date(now.getTime() - 4 * DAY) });
    // B: past its expiry, Bob signed and Carl did not.
    await request('sgn_b', { status: 'in_progress', expiresAt: new Date(now.getTime() - 3_600_000) });
    await signer('sgn_b', 'Bob', { status: 'signed' });
    await signer('sgn_b', 'Carl', { status: 'opened', sentAt: new Date(now.getTime() - 20 * DAY) });
    // C: past its expiry, but everyone signed: that is finalizing's job, not expiry's.
    await request('sgn_c', { status: 'in_progress', expiresAt: new Date(now.getTime() - 3_600_000) });
    await signer('sgn_c', 'Dan', { status: 'signed' });
    // A live link seeds the workspace into the due index.
    await master.insert(masterSchema.signLinkRegistry).values({
      id: generateId('sgl'),
      tokenHash: 'a'.repeat(64),
      workspaceId: 'ws_sweep',
      clerkOrgId: ORG,
      envelopeId: 'sgn_a',
      recipientId: ann,
    });
    const d1 = createSqliteD1(MIGRATION);
    const env = { SCHEDULE_INDEX: d1, WORKSPACE_CACHE: createMemoryKv(), SIGN_PORTAL_URL: 'https://sign.test', ENVIRONMENT: 'test' } as unknown as Env;
    const nextDue = async () =>
      (await d1.prepare("SELECT next_due_at FROM workspace_due_index WHERE kind = 'sign_lifecycle'").first<{ next_due_at: number }>())?.next_due_at;

    const first = await runLifecycleSweep(env, now);
    expect(first).toMatchObject({ seeded: 1, processed: 1, expired: 1, reminded: 1 });
    expect((await envelope('sgn_b')).status).toBe('expired');
    expect((await envelope('sgn_c')).status).toBe('in_progress');
    expect(published).toEqual([expect.objectContaining({ action: 'expired', entityId: 'sgn_b' })]);
    const toSender = mail.transport!.sent.find((m) => m.subject.includes('expired'));
    expect(toSender?.text).toContain('Carl');
    const reminder = mail.transport!.sent.find((m) => m.subject.startsWith('Reminder:'));
    expect(reminder?.text).toMatch(/https:\/\/sign\.test\/r\//);
    expect(await recipient(ann)).toMatchObject({ remindersSent: 1, lastRemindedAt: now });
    // Next: Ann's second reminder, three days on.
    expect(await nextDue()).toBe(now.getTime() + 3 * DAY);

    // The same tick again finds nothing due: once per interval.
    mail.transport = memoryTransport();
    expect(await runLifecycleSweep(env, now)).toMatchObject({ due: 0, reminded: 0 });
    expect(mail.transport.sent).toHaveLength(0);

    const later = new Date(now.getTime() + 3 * DAY + 60_000);
    expect(await runLifecycleSweep(env, later)).toMatchObject({ reminded: 1 });
    expect((await recipient(ann)).remindersSent).toBe(2);
    // The maximum is reached; what is left is A's expiry.
    expect(await nextDue()).toBe(now.getTime() + 10 * DAY);
  });
});
