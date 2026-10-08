/**
 * DB-backed tests for the entity settings added for WeldBooks phase 0:
 * lock dates and their logged exceptions, adapter validation of tax
 * identifiers, jurisdiction changes and the shared address shape.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountingEntitiesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const PERMS = ['entities:read', 'entities:create', 'entities:update'];

function request(path: string, init?: { method?: string; body?: unknown; userId?: string }) {
  const { request: send } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
    context: {
      permissions: permissions(...PERMS),
      tenantDb: db,
      ...(init?.userId ? { userId: init.userId } : {}),
    },
  });
  return send(path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function createEntity(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request('/api/accounting-entities', {
    method: 'POST',
    body: { name, jurisdictionCode: 'NL', seedDefaults: false, ...extra },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

/** A YYYY-MM-DD date `days` from today (UTC). */
function day(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { message: string } };
  return body.error.message;
}

describe('/api/accounting-entities · lock dates', () => {
  it('sets, changes and clears the soft lock dates', async () => {
    const id = await createEntity('Lock Soft BV');

    const set = await request(`/api/accounting-entities/${id}/lock-dates`, {
      method: 'PATCH',
      body: { salesLockDate: '2026-03-31', purchaseLockDate: '2026-03-31', taxLockDate: '2026-06-30', periodLockDate: '2026-01-31' },
    });
    expect(set.status).toBe(200);
    const body = (await set.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id,
      salesLockDate: '2026-03-31',
      purchaseLockDate: '2026-03-31',
      taxLockDate: '2026-06-30',
      periodLockDate: '2026-01-31',
      hardLockDate: null,
    });

    const clear = await request(`/api/accounting-entities/${id}/lock-dates`, {
      method: 'PATCH',
      body: { salesLockDate: null, periodLockDate: '2026-02-28' },
    });
    expect(clear.status).toBe(200);
    const [row] = await db.select().from(schema.entities).where(eq(schema.entities.id, id)).limit(1);
    expect(row?.salesLockDate).toBeNull();
    expect(row?.purchaseLockDate).toBe('2026-03-31');
    expect(row?.periodLockDate).toBe('2026-02-28');

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit.some((a) => a.action === 'lock_dates_updated')).toBe(true);
  });

  it('rejects malformed dates', async () => {
    const id = await createEntity('Lock Format BV');
    const res = await request(`/api/accounting-entities/${id}/lock-dates`, {
      method: 'PATCH',
      body: { salesLockDate: '2026-02-30' },
    });
    expect(res.status).toBe(400);
  });

  it('only moves the hard lock date forward, and never past today', async () => {
    const id = await createEntity('Lock Hard BV');
    const path = `/api/accounting-entities/${id}/lock-dates`;

    expect((await request(path, { method: 'PATCH', body: { hardLockDate: day(-20) } })).status).toBe(200);

    const earlier = await request(path, { method: 'PATCH', body: { hardLockDate: day(-40) } });
    expect(earlier.status).toBe(400);
    expect(await errorMessage(earlier)).toBe('The hard lock date can only move forward');

    const cleared = await request(path, { method: 'PATCH', body: { hardLockDate: null } });
    expect(cleared.status).toBe(400);
    expect(await errorMessage(cleared)).toBe('The hard lock date can only move forward');

    const future = await request(path, { method: 'PATCH', body: { hardLockDate: day(5) } });
    expect(future.status).toBe(400);

    expect((await request(path, { method: 'PATCH', body: { hardLockDate: day(-10) } })).status).toBe(200);
    const [row] = await db.select().from(schema.entities).where(eq(schema.entities.id, id)).limit(1);
    expect(row?.hardLockDate).toBe(day(-10));
  });

  it('404s for an unknown entity', async () => {
    const res = await request('/api/accounting-entities/ent_missing/lock-dates', {
      method: 'PATCH',
      body: { salesLockDate: '2026-01-31' },
    });
    expect(res.status).toBe(404);
  });
});

describe('/api/accounting-entities · lock date exceptions', () => {
  it('creates, lists (newest first, revoked included) and revokes exceptions', async () => {
    const id = await createEntity('Exception BV');
    const base = `/api/accounting-entities/${id}/lock-exceptions`;
    const endsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();

    const first = await request(base, {
      method: 'POST',
      body: { lockType: 'sales', userId: 'user_accountant', endsAt, reason: 'Late credit note for March' },
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { data: { id: string; createdBy: string; userId: string; revokedAt: string | null } };
    expect(created.data.id).toMatch(/^lde_/);
    expect(created.data.createdBy).toBe('user_test_default');
    expect(created.data.userId).toBe('user_accountant');
    expect(created.data.revokedAt).toBeNull();

    // Second exception, for everyone.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await request(base, {
      method: 'POST',
      body: { lockType: 'period', endsAt, reason: 'Year-end adjustments' },
    });
    expect(second.status).toBe(201);
    const everyone = (await second.json()) as { data: { id: string; userId: string | null } };
    expect(everyone.data.userId).toBeNull();

    const revoke = await request(`${base}/${created.data.id}/revoke`, { method: 'POST', userId: 'user_controller' });
    expect(revoke.status).toBe(200);
    const revoked = (await revoke.json()) as { data: { revokedAt: string | null; revokedBy: string | null } };
    expect(revoked.data.revokedAt).not.toBeNull();
    expect(revoked.data.revokedBy).toBe('user_controller');

    const listed = await request(base);
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as { data: Array<{ id: string; revokedAt: string | null }> };
    expect(rows.data.map((r) => r.id)).toEqual([everyone.data.id, created.data.id]);
    expect(rows.data[1]?.revokedAt).not.toBeNull();

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, created.data.id));
    expect(audit.map((a) => a.action).sort()).toEqual(['created', 'revoked']);
  });

  it('validates endsAt and reason', async () => {
    const id = await createEntity('Exception Rules BV');
    const base = `/api/accounting-entities/${id}/lock-exceptions`;

    const past = await request(base, {
      method: 'POST',
      body: { lockType: 'tax', endsAt: new Date(Date.now() - 60_000).toISOString(), reason: 'Too late' },
    });
    expect(past.status).toBe(400);

    const tooFar = await request(base, {
      method: 'POST',
      body: { lockType: 'tax', endsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(), reason: 'Too long' },
    });
    expect(tooFar.status).toBe(400);

    const shortReason = await request(base, {
      method: 'POST',
      body: { lockType: 'tax', endsAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'ok' },
    });
    expect(shortReason.status).toBe(400);

    const hard = await request(base, {
      method: 'POST',
      body: { lockType: 'hard', endsAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'No exceptions to the hard lock' },
    });
    expect(hard.status).toBe(400);
  });

  it('404s when the exception belongs to another entity', async () => {
    const owner = await createEntity('Owner BV');
    const other = await createEntity('Other BV');
    const res = await request(`/api/accounting-entities/${owner}/lock-exceptions`, {
      method: 'POST',
      body: { lockType: 'purchase', endsAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Late supplier bill' },
    });
    const { data } = (await res.json()) as { data: { id: string } };

    const foreign = await request(`/api/accounting-entities/${other}/lock-exceptions/${data.id}/revoke`, { method: 'POST' });
    expect(foreign.status).toBe(404);
    const [row] = await db
      .select()
      .from(schema.lockDateExceptions)
      .where(eq(schema.lockDateExceptions.id, data.id))
      .limit(1);
    expect(row?.revokedAt).toBeNull();

    expect((await request('/api/accounting-entities/ent_missing/lock-exceptions')).status).toBe(404);
  });
});

describe('/api/accounting-entities · PATCH validation and addresses', () => {
  it('refuses a jurisdiction without an adapter', async () => {
    const id = await createEntity('Jurisdiction BV');
    const res = await request(`/api/accounting-entities/${id}`, { method: 'PATCH', body: { jurisdictionCode: 'XX' } });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(schema.entities).where(eq(schema.entities.id, id)).limit(1);
    expect(row?.jurisdictionCode).toBe('NL');
  });

  it('validates the VAT and registration numbers with the adapter (POST and PATCH)', async () => {
    const badPost = await request('/api/accounting-entities', {
      method: 'POST',
      body: { name: 'Bad VAT BV', jurisdictionCode: 'NL', vatNumber: 'DE123456789', seedDefaults: false },
    });
    expect(badPost.status).toBe(400);
    expect(await errorMessage(badPost)).toContain('NL123456789B01');

    const id = await createEntity('Tax Id BV', { taxIdentifiers: { vatNumber: 'nl 123456789 b01' } });
    const [created] = await db.select().from(schema.entities).where(eq(schema.entities.id, id)).limit(1);
    expect(created?.taxIdentifiers?.vatNumber).toBe('NL123456789B01');

    const badKvk = await request(`/api/accounting-entities/${id}`, {
      method: 'PATCH',
      body: { taxIdentifiers: { registrationNumber: '123' } },
    });
    expect(badKvk.status).toBe(400);
    expect(await errorMessage(badKvk)).toContain('8 digits');

    const good = await request(`/api/accounting-entities/${id}`, {
      method: 'PATCH',
      body: { taxIdentifiers: { registrationNumber: '1234 5678' } },
    });
    expect(good.status).toBe(200);
    const body = (await good.json()) as { data: { taxIdentifiers: { vatNumber?: string; registrationNumber?: string } } };
    expect(body.data.taxIdentifiers).toMatchObject({ vatNumber: 'NL123456789B01', registrationNumber: '12345678' });
  });

  it('stores the address in the shared shape, whichever shape comes in', async () => {
    const id = await createEntity('Address BV', {
      address: { street: 'Keizersgracht', houseNumber: '100', postalCode: '1015 AA', city: 'Amsterdam', province: 'Noord-Holland', country: 'nl' },
    });
    const [created] = await db.select().from(schema.entities).where(eq(schema.entities.id, id)).limit(1);
    expect(created?.address).toEqual({
      line1: 'Keizersgracht 100',
      postalCode: '1015 AA',
      city: 'Amsterdam',
      state: 'Noord-Holland',
      country: 'NL',
    });

    const res = await request(`/api/accounting-entities/${id}`, {
      method: 'PATCH',
      body: { address: { line1: '100 Congress Ave', line2: 'Suite 200', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { address: Record<string, string> } };
    expect(body.data.address).toEqual({
      line1: '100 Congress Ave',
      line2: 'Suite 200',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    });
  });

  it('GET /jurisdictions carries features and terminology', async () => {
    const res = await request('/api/accounting-entities/jurisdictions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ code: string; features: Record<string, boolean>; terminology: Record<string, string> }>;
    };
    const nl = body.data.find((j) => j.code === 'NL');
    expect(nl?.features.vatReturn).toBe(true);
    expect(nl?.terminology.tax).toBe('vat');
  });
});
