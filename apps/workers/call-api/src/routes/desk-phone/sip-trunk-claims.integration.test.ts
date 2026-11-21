/**
 * Who holds a number in the master registry when two workspaces want it, or
 * when a trunk goes while a number is being added to it, on pglite.
 *
 * TypeScript only: these tests run two requests at once, or change the
 * database between two steps of one request, which the conformance replay
 * (one request at a time, the same state for both backends) cannot do. What
 * each outcome looks like from the outside is in sip-trunks.integration.test.ts,
 * which both backends run.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb, createSeparatePgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({
  master: null as unknown,
  /** Runs once, between a request's look at the registry and its claim. */
  beforeClaim: null as null | (() => Promise<void>),
}));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => holder.master };
});
vi.mock('../../lib/phone-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/phone-registry')>();
  return {
    ...actual,
    claimPhoneNumberRegistry: async (...args: Parameters<typeof actual.claimPhoneNumberRegistry>) => {
      const hook = holder.beforeClaim;
      holder.beforeClaim = null;
      await hook?.();
      return actual.claimPhoneNumberRegistry(...args);
    },
  };
});

import { deskPhoneSipTrunkRoutes } from './sip-trunks';
import {
  claimPhoneNumberRegistry,
  deactivatePhoneNumberRegistry,
  releasePhoneNumberRegistry,
} from '../../lib/phone-registry';

const BASE = '/api/desk/phone/sip-trunks';
const HERE = 'org_claims_here';
const THERE = 'org_claims_there';
const ENV = { TELNYX_API_KEY: 'telnyx-key', TELNYX_CONNECTION_ID: 'conn-1' } as never;

let here: Database;
let there: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

function send(tenant: { db: Database; org: string }, method: string, path: string, body?: unknown) {
  const { request } = createTestApp(BASE, deskPhoneSipTrunkRoutes, {
    context: { tenantDb: tenant.db, clerkOrgId: tenant.org, permissions: permissions('conversations:read', 'settings:manage') },
    env: ENV,
  });
  return request(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error;

async function entry(phoneNumber: string) {
  const [row] = await master
    .select()
    .from(masterSchema.phoneNumberRegistry)
    .where(eq(masterSchema.phoneNumberRegistry.phoneNumber, phoneNumber));
  return row as { isActive: boolean; voipPhoneNumberId: string; clerkOrgId: string } | undefined;
}

const numbersOf = (db: Database, phoneNumber: string) =>
  db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.phoneNumber, phoneNumber));

const trunkRow = (id: string): typeof schema.voipSipTrunks.$inferInsert => ({
  id,
  name: id,
  provider: 'other',
  authMode: 'ip',
  providerConnectionId: `conn-${id}`,
  status: 'active',
});

beforeAll(async () => {
  here = (await createPgliteDb()).db;
  // A tenant database of its own: the second workspace.
  there = (await createSeparatePgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await here.insert(schema.voipSipTrunks).values(trunkRow('strk_here'));
  await there.insert(schema.voipSipTrunks).values(trunkRow('strk_there'));
}, 240_000);

beforeEach(() => {
  holder.beforeClaim = null;
});

describe('the claim of a number', () => {
  const own = (phoneNumber: string, id: string, org = HERE) => ({ phoneNumber, clerkOrgId: org, voipPhoneNumberId: id });

  it('takes a free number, and its own entry again', async () => {
    expect(await claimPhoneNumberRegistry(ENV, own('+31201400001', 'vpn_a'))).toBe(true);
    expect(await entry('+31201400001')).toMatchObject({ clerkOrgId: HERE, voipPhoneNumberId: 'vpn_a', isActive: true });
    expect(await claimPhoneNumberRegistry(ENV, own('+31201400001', 'vpn_a'))).toBe(true);
  });

  it('is refused by another workspace’s entry, active or not, and changes nothing', async () => {
    expect(await claimPhoneNumberRegistry(ENV, own('+31201400001', 'vpn_b', THERE))).toBe(false);
    expect(await entry('+31201400001')).toMatchObject({ clerkOrgId: HERE, voipPhoneNumberId: 'vpn_a', isActive: true });

    await deactivatePhoneNumberRegistry(ENV, own('+31201400001', 'vpn_a'));
    expect((await entry('+31201400001'))!.isActive).toBe(false);
    expect(await claimPhoneNumberRegistry(ENV, { ...own('+31201400001', 'vpn_b', THERE), reclaimIds: ['vpn_a'] })).toBe(false);
    expect(await entry('+31201400001')).toMatchObject({ clerkOrgId: HERE, voipPhoneNumberId: 'vpn_a', isActive: false });
  });

  it('takes over its own entry for another row only when the caller names that row', async () => {
    expect(await claimPhoneNumberRegistry(ENV, own('+31201400001', 'vpn_c'))).toBe(false);
    expect(await claimPhoneNumberRegistry(ENV, { ...own('+31201400001', 'vpn_c'), reclaimIds: ['vpn_a'] })).toBe(true);
    expect(await entry('+31201400001')).toMatchObject({ clerkOrgId: HERE, voipPhoneNumberId: 'vpn_c', isActive: true });
  });

  it('is let go of, or switched off, only by its own workspace and row', async () => {
    await deactivatePhoneNumberRegistry(ENV, own('+31201400001', 'vpn_c', THERE));
    await deactivatePhoneNumberRegistry(ENV, own('+31201400001', 'vpn_a'));
    await releasePhoneNumberRegistry(ENV, own('+31201400001', 'vpn_c', THERE));
    await releasePhoneNumberRegistry(ENV, own('+31201400001', 'vpn_a'));
    expect(await entry('+31201400001')).toMatchObject({ clerkOrgId: HERE, voipPhoneNumberId: 'vpn_c', isActive: true });
    await releasePhoneNumberRegistry(ENV, own('+31201400001', 'vpn_c'));
    expect(await entry('+31201400001')).toBeUndefined();
  });
});

describe('two workspaces adding one number at once', () => {
  it('lets exactly one of them have it', async () => {
    const [a, b] = await Promise.all([
      send({ db: here, org: HERE }, 'POST', '/strk_here/numbers', { phoneNumber: '+31201400010' }),
      send({ db: there, org: THERE }, 'POST', '/strk_there/numbers', { phoneNumber: '+31201400010' }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
    const winner = a.status === 201 ? { db: here, org: HERE, loser: there } : { db: there, org: THERE, loser: here };
    const [won] = await numbersOf(winner.db, '+31201400010');
    expect(won).toMatchObject({ deletedAt: null, status: 'active' });
    expect(await entry('+31201400010')).toMatchObject({ clerkOrgId: winner.org, voipPhoneNumberId: won!.id, isActive: true });
    // The other workspace is left without a live number.
    const lost = await numbersOf(winner.loser, '+31201400010');
    expect(lost.every((row) => row.deletedAt !== null)).toBe(true);
  });

  it('takes the row back when the number is taken between the look and the claim', async () => {
    holder.beforeClaim = async () => {
      await master.insert(masterSchema.phoneNumberRegistry).values({
        phoneNumber: '+31201400011',
        clerkOrgId: THERE,
        voipPhoneNumberId: 'vpn_theirs_11',
      });
    };
    const res = await send({ db: here, org: HERE }, 'POST', '/strk_here/numbers', { phoneNumber: '+31201400011' });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('number_taken');
    expect(await entry('+31201400011')).toMatchObject({ clerkOrgId: THERE, voipPhoneNumberId: 'vpn_theirs_11', isActive: true });
    const rows = await numbersOf(here, '+31201400011');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'inactive' });
    expect(rows[0]!.deletedAt).not.toBeNull();
  });
});

describe('adding a number to a trunk that is being deleted', () => {
  it('leaves no live number on the deleted trunk, and no entry in the registry', async () => {
    await here.insert(schema.voipSipTrunks).values(trunkRow('strk_going'));
    // The trunk's delete ran (its row, then the numbers it found) before this number was written.
    holder.beforeClaim = async () => {
      await here.delete(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.id, 'strk_going'));
    };
    const res = await send({ db: here, org: HERE }, 'POST', '/strk_going/numbers', { phoneNumber: '+31201400020' });
    expect(res.status).toBe(404);
    const rows = await numbersOf(here, '+31201400020');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'inactive', sipTrunkId: 'strk_going' });
    expect(rows[0]!.deletedAt).not.toBeNull();
    expect(await entry('+31201400020')).toBeUndefined();
  });
});
