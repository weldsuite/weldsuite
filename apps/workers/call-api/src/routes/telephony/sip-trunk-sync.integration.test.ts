/**
 * "Sync numbers" pulls the workspace's Telnyx numbers in; a number on the
 * customer's own phone system (provider `sip_trunk`) is not Telnyx's to
 * describe, so a sync leaves its row and registry entry as they are, even when
 * the same number turns up in the Telnyx listing; nor does "delete number" release it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { stubTelnyx } from '../../test/telnyx-stub';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { telephonyRoutes } from './index';

const BASE = '/api/telephony';
let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const telnyx = stubTelnyx();

function send(method: string, path: string) {
  const { request } = createTestApp(BASE, telephonyRoutes, {
    context: { tenantDb: db, masterDb: master, permissions: permissions('telephony:read', 'telephony:manage') },
    env: { TELNYX_API_KEY: 'telnyx-key', TELNYX_CONNECTION_ID: 'conn-1', ENVIRONMENT: 'development' } as never,
  });
  return request(`${BASE}${path}`, { method });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await db.insert(schema.voipSipTrunks).values({ id: 'strk_sync', name: 'PBX', authMode: 'ip', providerConnectionId: 'conn-pbx' });
  await db.insert(schema.voipPhoneNumbers).values([
    {
      id: 'vpn_sync_trunk', provider: 'sip_trunk', phoneNumber: '+31201350001', countryCode: 'NL', status: 'active',
      sipTrunkId: 'strk_sync', providerConnectionId: 'conn-pbx', allowOutbound: false,
    },
    { id: 'vpn_sync_hosted', provider: 'telnyx', phoneNumber: '+31201350002', countryCode: 'NL', status: 'pending' },
  ]);
  await master.insert(masterSchema.phoneNumberRegistry).values([
    { phoneNumber: '+31201350001', clerkOrgId: 'org_test_default', voipPhoneNumberId: 'vpn_sync_trunk' },
    { phoneNumber: '+31201350002', clerkOrgId: 'org_test_default', voipPhoneNumberId: 'vpn_sync_hosted' },
  ]);
  telnyx.on('GET', '/phone_numbers', {
    data: [
      { id: 'tx-trunk', phone_number: '+31201350001', connection_id: 'conn-1' },
      { id: 'tx-hosted', phone_number: '+31201350002', connection_id: 'conn-1' },
    ],
  });
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('POST /phone-numbers/sync', () => {
  it('leaves a trunk number alone and still syncs the hosted ones', async () => {
    const res = await send('POST', '/phone-numbers/sync');
    expect(await res.json()).toEqual({ data: { count: 1 } });
    const [trunk] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.id, 'vpn_sync_trunk'));
    expect(trunk).toMatchObject({
      provider: 'sip_trunk',
      sipTrunkId: 'strk_sync',
      providerConnectionId: 'conn-pbx',
      providerPhoneNumberId: null,
      allowOutbound: false,
    });
    const [hosted] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.id, 'vpn_sync_hosted'));
    expect(hosted).toMatchObject({ status: 'active', providerPhoneNumberId: 'tx-hosted', providerConnectionId: 'conn-1' });
  });
});

describe('DELETE /phone-numbers/:id', () => {
  it('does not release a trunk number (it is removed from its phone system)', async () => {
    const res = await send('DELETE', '/phone-numbers/vpn_sync_trunk');
    expect(res.status).toBe(409);
    const [trunk] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.id, 'vpn_sync_trunk'));
    expect(trunk!.deletedAt).toBeNull();
  });
});
