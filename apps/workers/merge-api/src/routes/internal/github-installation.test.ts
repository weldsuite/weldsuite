/**
 * GitHub `installation` events into the connection (POST /internal/github-event)
 * on a real tenant schema and a master database (pglite). What must not regress:
 *   1. `deleted` revokes every live connection of the installation, drops its row
 *      from the master installation index, and publishes merge_connection:updated.
 *   2. `suspend` / `unsuspend` move the connection to suspended / active.
 *   3. Other actions, an unknown installation and a payload without one are
 *      ignored; connections of other installations are left alone.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import internalRoutes from './index';
import { ADMIN, clearEvents, data, eventTypes, events, jsonInit, makeApp, newId, openDb, resetTables } from '../../test/helpers';
import { seedConnection } from '../../test/seed';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  db = await openDb();
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  await master.delete(masterSchema.mergeProviderIndex);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const send = async (action: string, installation: Record<string, unknown> | null = { id: 4242 }) => {
  const res = await makeApp(db, '/internal', internalRoutes, { grants: ADMIN, masterDb: master }).request(
    '/internal/github-event',
    jsonInit({ workspaceId: 'org_alpha', event: 'installation', deliveryId: 'd-1', payload: { action, ...(installation ? { installation } : {}) } }),
  );
  expect(res.status).toBe(200);
  return data<{ outcome: string; reason?: string }>(res);
};

const statusOf = async (id: string) => (await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, id)))[0]!;

async function indexInstallation(id: string) {
  await master.insert(masterSchema.mergeProviderIndex).values({
    id: `mpi_${id}`,
    provider: 'github',
    kind: 'installation',
    externalKey: id,
    workspaceId: 'ws_alpha',
  });
}

describe('installation events', () => {
  it('deleted revokes the connection, removes the index row and publishes updated', async () => {
    const connection = await seedConnection(db, { externalAccountId: '4242' });
    const other = await seedConnection(db, { externalAccountId: '5555' });
    await indexInstallation('4242');
    await indexInstallation('5555');
    clearEvents();

    expect(await send('deleted')).toEqual({ outcome: 'applied' });
    const row = await statusOf(connection.id);
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();
    expect((await statusOf(other.id)).status).toBe('active');
    expect((await master.select().from(masterSchema.mergeProviderIndex)).map((r: { externalKey: string }) => r.externalKey)).toEqual(['5555']);

    expect(eventTypes()).toEqual(['merge_connection:updated']);
    expect(events[0]).toMatchObject({
      entityId: connection.id,
      data: { id: newId(connection.id), provider: 'github', accountLogin: 'acme', status: 'revoked' },
      changes: { status: { old: 'active', new: 'revoked' } },
    });
    expect(events[0]!.metadata.source).toBe('system');
  });

  it('suspend and unsuspend move the status and keep the index row', async () => {
    const connection = await seedConnection(db, { externalAccountId: '4242' });
    await indexInstallation('4242');
    clearEvents();

    expect(await send('suspend')).toEqual({ outcome: 'applied' });
    expect((await statusOf(connection.id)).status).toBe('suspended');
    expect(events[0]!.changes).toEqual({ status: { old: 'active', new: 'suspended' } });
    expect(await send('unsuspend')).toEqual({ outcome: 'applied' });
    const row = await statusOf(connection.id);
    expect(row.status).toBe('active');
    expect(row.revokedAt).toBeNull();
    expect(eventTypes()).toEqual(['merge_connection:updated', 'merge_connection:updated']);
    expect(await master.select().from(masterSchema.mergeProviderIndex)).toHaveLength(1);
  });

  it('ignores other actions, an unknown installation, a payload without one, and removed connections', async () => {
    const connection = await seedConnection(db, { externalAccountId: '4242' });
    await seedConnection(db, { externalAccountId: '6666', deletedAt: new Date() });
    clearEvents();
    expect(await send('created')).toEqual({ outcome: 'ignored', reason: 'unsupported_action' });
    expect(await send('new_permissions_accepted')).toEqual({ outcome: 'ignored', reason: 'unsupported_action' });
    expect(await send('deleted', { id: 9999 })).toEqual({ outcome: 'ignored', reason: 'untracked_installation' });
    expect(await send('deleted', { id: 6666 })).toEqual({ outcome: 'ignored', reason: 'untracked_installation' });
    expect(await send('deleted', null)).toEqual({ outcome: 'ignored', reason: 'no_installation' });
    expect((await statusOf(connection.id)).status).toBe('active');
    expect(events).toEqual([]);
  });
});
