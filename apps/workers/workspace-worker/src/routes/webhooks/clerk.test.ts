/**
 * The Clerk `organization.deleted` cascade and database moves: while a move
 * owns the workspace's database the cascade changes nothing and answers a
 * retryable 500 (Svix redelivers); once the move is over it goes through and
 * drops the database as before. A teardown that fails is answered 500 too, so
 * it is retried rather than lost; the workspace is stamped `deleted_at` once,
 * on the first delivery that goes through. Real master schema (PGlite), the webhook
 * signed with a real Svix signature, the Neon drop a spy.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { eq } from 'drizzle-orm';
import { Webhook } from 'svix';
import { workspaceDatabaseMoves, workspaces } from '@weldsuite/db/schema/master';

const holder = vi.hoisted(() => ({
  masterDb: null as unknown,
  deleteWorkspaceDatabase: null as unknown as (...args: unknown[]) => Promise<{ success: boolean }>,
  /** When set, replaces the move check (to simulate a move that starts between the two checks). */
  hasActiveMove: null as null | (() => Promise<boolean>),
}));

vi.mock('@weldsuite/emails', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: vi.fn() }));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getMasterDb: () => holder.masterDb,
}));
vi.mock('@weldsuite/neon-provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/neon-provisioning')>()),
  createProvisioningService: () => ({ deleteWorkspaceDatabase: holder.deleteWorkspaceDatabase }),
}));
vi.mock('../../services/database-move/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/database-move/state')>();
  return {
    ...actual,
    hasActiveMove: (...args: Parameters<typeof actual.hasActiveMove>) =>
      holder.hasActiveMove ? holder.hasActiveMove() : actual.hasActiveMove(...args),
  };
});

import { CLERK_ORG_ID, WORKSPACE_ID, createLightWorld, createMoveMaster, type LightWorld, type MoveMaster } from '../../test/move-harness';
import type { Env } from '../../index';
import { startDatabaseMove } from '../../services/database-move';
import { clerkWebhookRoutes } from './clerk';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const WEBHOOK_SECRET = `whsec_${Buffer.from('a-test-secret-of-some-length-1234').toString('base64')}`;

let master: MoveMaster;
let world: LightWorld;
let deleteWorkspaceDatabase: Mock<(...args: unknown[]) => Promise<{ success: boolean; error?: string }>>;

beforeAll(async () => {
  master = await createMoveMaster();
});

afterAll(async () => {
  await master.close();
});

beforeEach(async () => {
  world = await createLightWorld(master);
  holder.masterDb = world.masterDb;
  holder.hasActiveMove = null;
  deleteWorkspaceDatabase = vi.fn(async () => ({ success: true }));
  holder.deleteWorkspaceDatabase = deleteWorkspaceDatabase;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({ CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, NEON_API_KEY: 'neon_key' }) as Env;

async function deliverOrganizationDeleted() {
  const body = JSON.stringify({
    type: 'organization.deleted',
    data: { id: CLERK_ORG_ID, name: 'Acme', slug: 'acme', image_url: null, created_by: 'user_1' },
  });
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const signature = new Webhook(WEBHOOK_SECRET).sign(id, timestamp, body);
  const res = await clerkWebhookRoutes.request(
    '/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'svix-signature': signature,
      },
      body,
    },
    env(),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function workspace() {
  const [row] = await world.masterDb.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID));
  if (!row) throw new Error('no workspace');
  return row;
}

async function startMove(): Promise<string> {
  const started = await startDatabaseMove(
    world.env,
    { workspaceId: WORKSPACE_ID, target: 'dedicated', startedBy: 'ops@weldsuite.org' },
    { masterDb: world.masterDb },
  );
  return started.moveId;
}

describe('organization.deleted and database moves', () => {
  it('soft-deletes the workspace, stamps deleted_at and drops its database when no move is running', async () => {
    const res = await deliverOrganizationDeleted();

    expect(res).toEqual({ status: 200, json: { received: true } });
    expect(await workspace()).toMatchObject({ isActive: false, deletedAt: expect.any(Date) });
    expect(deleteWorkspaceDatabase).toHaveBeenCalledTimes(1);
    expect(deleteWorkspaceDatabase).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID);
  });

  it('keeps a deleted_at that is already there (the scheduled-deletion sweep stamps it before the webhook lands)', async () => {
    const stampedAt = new Date('2026-10-01T03:00:00.000Z');
    await world.masterDb.update(workspaces).set({ deletedAt: stampedAt }).where(eq(workspaces.id, WORKSPACE_ID));

    expect((await deliverOrganizationDeleted()).status).toBe(200);
    expect((await workspace()).deletedAt).toEqual(stampedAt);
  });

  it.each(['queued', 'copying', 'switching', 'cancelling'] as const)(
    'defers while a move is %s: nothing is changed, nothing dropped, and the answer is a retryable 500',
    async (status) => {
      const moveId = await startMove();
      await world.masterDb.update(workspaceDatabaseMoves).set({ status }).where(eq(workspaceDatabaseMoves.id, moveId));

      const res = await deliverOrganizationDeleted();

      expect(res.status).toBe(500);
      expect(res.json).toMatchObject({ code: 'DATABASE_MOVE_ACTIVE' });
      expect(await workspace()).toMatchObject({ isActive: true, deletedAt: null });
      expect(deleteWorkspaceDatabase).not.toHaveBeenCalled();
    },
  );

  it('goes through when Svix redelivers after the move ended', async () => {
    const moveId = await startMove();
    expect((await deliverOrganizationDeleted()).status).toBe(500);

    await world.masterDb.update(workspaceDatabaseMoves).set({ status: 'failed' }).where(eq(workspaceDatabaseMoves.id, moveId));
    const retried = await deliverOrganizationDeleted();

    expect(retried.status).toBe(200);
    expect((await workspace()).isActive).toBe(false);
    expect(deleteWorkspaceDatabase).toHaveBeenCalledTimes(1);
  });

  it('is not held back by a move that completed', async () => {
    const moveId = await startMove();
    await world.masterDb.update(workspaceDatabaseMoves).set({ status: 'completed' }).where(eq(workspaceDatabaseMoves.id, moveId));

    expect((await deliverOrganizationDeleted()).status).toBe(200);
    expect(deleteWorkspaceDatabase).toHaveBeenCalledTimes(1);
  });

  it('answers a retryable 500 when the database teardown fails, and finishes it on redelivery', async () => {
    deleteWorkspaceDatabase.mockResolvedValueOnce({ success: false, error: 'Neon is unavailable' });

    const failed = await deliverOrganizationDeleted();

    expect(failed.status).toBe(500);
    expect(failed.json.error).not.toContain('Neon is unavailable');
    const afterFailure = await workspace();
    expect(afterFailure).toMatchObject({ isActive: false, deletedAt: expect.any(Date) });

    const retried = await deliverOrganizationDeleted();

    expect(retried).toEqual({ status: 200, json: { received: true } });
    expect(deleteWorkspaceDatabase).toHaveBeenCalledTimes(2);
    // The redelivery keeps the first stamp: the teardown retry sweep counts its margin from it.
    expect((await workspace()).deletedAt).toEqual(afterFailure.deletedAt);
  });

  it('looks again right before the drop: a move started after the first check still stops it', async () => {
    holder.hasActiveMove = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const res = await deliverOrganizationDeleted();

    expect(holder.hasActiveMove).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ code: 'DATABASE_MOVE_ACTIVE' });
    expect(deleteWorkspaceDatabase).not.toHaveBeenCalled();
  });
});
