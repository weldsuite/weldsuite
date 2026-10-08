/**
 * The WeldBooks resources the public API serves for reading only.
 *
 * The ledger changes only through books-api (tax, numbering, posting, lock
 * dates, entity seeding and the audit log all live there), so on these
 * resources every write answers 405 and nothing reaches the database. Reads
 * keep their scope check, cursor pagination and `entityId` filter. Accounting
 * contacts are the one WeldBooks resource that stays writable, limited to a
 * name and a role.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { CRUD_ENTITIES, READ_ONLY_SEGMENTS } from './entities';
import { buildCreateBody } from './factory';
import type { Database } from '../db';
import { schema } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

const scopeOf = (seg: string) => seg.replaceAll('-', '_');

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

interface ErrorBody {
  error: { code: string; message: string };
}

describe('external-api · read-only WeldBooks resources', () => {
  for (const seg of READ_ONLY_SEGMENTS) {
    const scope = scopeOf(seg);

    describe(`/v1/${seg}`, () => {
      it('answers every write method with 405 METHOD_NOT_ALLOWED, whatever the key holds', async () => {
        const scopeSets = [['*'], [`${scope}:read`, `${scope}:write`], [`${scope}:write`], [`${scope}:read`], []];
        // The collection takes POST; the singleton takes every method there too.
        for (const scopes of scopeSets) {
          const { request } = createExternalTestApp({ scopes, tenantDb: db });
          for (const method of WRITE_METHODS) {
            for (const path of [`/v1/${seg}`, `/v1/${seg}/some_record_id`]) {
              const res = await request(path, {
                method,
                headers: JSON_HEADERS,
                body: method === 'DELETE' ? undefined : JSON.stringify({ name: 'Should not be written' }),
              });
              const context = `${method} ${path} scopes=[${scopes.join(',')}]`;
              expect(res.status, context).toBe(405);
              expect(res.headers.get('Allow'), context).toBe('GET, HEAD, OPTIONS');
              const body = (await res.json()) as ErrorBody;
              expect(body.error.code, context).toBe('METHOD_NOT_ALLOWED');
              expect(body.error.message, context).toContain('read-only');
              expect(body.error.message, context).toContain('WeldBooks');
            }
          }
        }
      });

      it('writes with no session still get 401, not 405', async () => {
        const { request } = createExternalTestApp({ session: null, tenantDb: db });
        const res = await request(`/v1/${seg}`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
        expect(res.status).toBe(401);
      });
    });
  }

  it('persists nothing when a write is attempted', async () => {
    const { request } = createExternalTestApp({ scopes: ['*'], tenantDb: db });
    const countOf = async (seg: string) => {
      const res = await request(`/v1/${seg}?limit=1`);
      expect(res.status, `GET /v1/${seg}`).toBe(200);
      return ((await res.json()) as { pagination: { totalCount: number } }).pagination.totalCount;
    };

    for (const { seg, create } of CRUD_ENTITIES.filter((e) => e.readOnly && e.create)) {
      const before = await countOf(seg);
      const body = { ...buildCreateBody(create!), entityId: 'ent_readonly_probe' };
      const res = await request(`/v1/${seg}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
      expect(res.status, `POST /v1/${seg}`).toBe(405);
      expect(await countOf(seg), `rows in ${seg}`).toBe(before);
    }
  });
});

describe('external-api · read-only WeldBooks resources keep reading', () => {
  const now = new Date();
  const entityId = 'ent_ro_reads_001';
  const otherEntityId = 'ent_ro_reads_002';
  const accountIds = ['acc_ro_reads_001', 'acc_ro_reads_002'];
  const deletedAccountId = 'acc_ro_reads_del';

  beforeAll(async () => {
    await db.insert(schema.entities).values(
      [entityId, otherEntityId].map((id) => ({
        id,
        name: `Read-only entity ${id}`,
        jurisdictionCode: 'NL',
        baseCurrency: 'EUR',
        locale: 'nl-NL',
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(schema.accounts).values([
      ...accountIds.map((id, i) => ({
        id,
        entityId,
        code: `90${i}`,
        name: `Account ${i}`,
        type: 'asset',
        normalSide: 'debit',
        createdAt: new Date(now.getTime() + i * 1000),
        updatedAt: now,
      })),
      {
        id: deletedAccountId,
        entityId,
        code: '909',
        name: 'Deleted account',
        type: 'asset',
        normalSide: 'debit',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
    ]);
  }, 30_000);

  const app = (scopes: string[]) => createExternalTestApp({ scopes, tenantDb: db }).request;

  it('lists with cursor pagination and the entityId filter, without soft-deleted rows', async () => {
    const request = app(['gl_accounts:read']);

    const first = await request(`/v1/gl-accounts?entityId=${entityId}&limit=1`);
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      data: Array<{ id: string; entityId: string }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(page1.data).toHaveLength(1);
    expect(page1.data[0]!.id).toBe(accountIds[1]); // newest first
    expect(page1.data[0]!.entityId).toBe(entityId);
    expect(page1.pagination).toEqual({ totalCount: 2, hasMore: true, cursor: accountIds[1] });

    const second = await request(`/v1/gl-accounts?entityId=${entityId}&limit=1&cursor=${page1.pagination.cursor}`);
    const page2 = (await second.json()) as { data: Array<{ id: string }>; pagination: { hasMore: boolean } };
    expect(page2.data.map((a) => a.id)).toEqual([accountIds[0]]);
    expect(page2.pagination.hasMore).toBe(false);

    const other = await request(`/v1/gl-accounts?entityId=${otherEntityId}`);
    expect(((await other.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('gets one record, and 404s on unknown and soft-deleted ids', async () => {
    const request = app(['gl_accounts:read', 'accounting_entities:read']);

    const ok = await request(`/v1/gl-accounts/${accountIds[0]}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { id: string } }).data.id).toBe(accountIds[0]);

    for (const id of [deletedAccountId, 'acc_does_not_exist']) {
      const res = await request(`/v1/gl-accounts/${id}`);
      expect(res.status, id).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe('NOT_FOUND');
    }

    const entity = await request(`/v1/accounting-entities/${entityId}`);
    expect(entity.status).toBe(200);
    expect(((await entity.json()) as { data: { jurisdictionCode: string } }).data.jurisdictionCode).toBe('NL');
  });

  it('still requires the read scope', async () => {
    const res = await app(['gl_accounts:write'])(`/v1/gl-accounts/${accountIds[0]}`);
    expect(res.status).toBe(403);
  });

  it('does not touch a record that a write attempt targets', async () => {
    const request = app(['*']);
    const patch = await request(`/v1/gl-accounts/${accountIds[0]}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(patch.status).toBe(405);
    const del = await request(`/v1/gl-accounts/${accountIds[0]}`, { method: 'DELETE' });
    expect(del.status).toBe(405);

    const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountIds[0]!));
    expect(row?.name).toBe('Account 0');
    expect(row?.deletedAt).toBeNull();
  });
});

describe('external-api · accounting settings (read-only singleton)', () => {
  const settingsId = 'acs_ro_reads_001';
  const request = (scopes: string[]) => createExternalTestApp({ scopes, tenantDb: db }).request;

  it('GET does not create the row when there is none: 404, and the table stays empty', async () => {
    await db.delete(schema.settings);
    const res = await request(['accounting_settings:read'])('/v1/accounting-settings');
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('NOT_FOUND');
    expect(await db.select().from(schema.settings)).toHaveLength(0);
  });

  it('GET returns the row books-api created', async () => {
    const now = new Date();
    await db.insert(schema.settings).values({ id: settingsId, createdAt: now, updatedAt: now });
    const res = await request(['accounting_settings:read'])('/v1/accounting-settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; accountingMethod: string } };
    expect(body.data.id).toBe(settingsId);
    expect(body.data.accountingMethod).toBe('accrual');
  });

  it('GET without the read scope → 403', async () => {
    const res = await request(['accounting_settings:write'])('/v1/accounting-settings');
    expect(res.status).toBe(403);
  });

  it('PATCH leaves the row as it was', async () => {
    const res = await request(['*'])('/v1/accounting-settings', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ defaultEntityId: 'ent_other', accountingMethod: 'cash' }),
    });
    expect(res.status).toBe(405);
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, settingsId));
    expect(row?.defaultEntityId).toBeNull();
    expect(row?.accountingMethod).toBe('accrual');
  });
});

describe('external-api · accounting contacts stay writable, as a name and a role', () => {
  // `db` is assigned in beforeAll, so build the app per request.
  const request = (path: string, init?: RequestInit) =>
    createExternalTestApp({ scopes: ['accounting_contacts:read', 'accounting_contacts:write'], tenantDb: db }).request(
      path,
      init,
    );

  it('creates, updates and deletes a contact', async () => {
    const created = await request('/v1/accounting-contacts', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Smith Industries', type: 'supplier' }),
    });
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    const patched = await request(`/v1/accounting-contacts/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Smith & Sons', type: 'both' }),
    });
    expect(patched.status).toBe(200);
    const [row] = await db.select().from(schema.parties).where(eq(schema.parties.id, id));
    expect(row?.displayName).toBe('Smith & Sons');
    expect(row?.role).toBe('both');

    const deleted = await request(`/v1/accounting-contacts/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect((await request(`/v1/accounting-contacts/${id}`)).status).toBe(404);
  });

  it('writes only the name and the role: ledger-adjacent party columns are ignored', async () => {
    const extras = {
      outstandingBalance: '999.00',
      defaultRevenueAccountId: 'acc_forged_revenue',
      defaultExpenseAccountId: 'acc_forged_expense',
      taxExempt: true,
      currency: 'USD',
      partyCode: 'FORGED-CODE',
      billingAddress: { street: 'Not an address shape' },
    };

    const created = await request('/v1/accounting-contacts', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Mass Assignment BV', ...extras }),
    });
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    const patched = await request(`/v1/accounting-contacts/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Mass Assignment Ltd', ...extras }),
    });
    expect(patched.status).toBe(200);

    const [row] = await db.select().from(schema.parties).where(eq(schema.parties.id, id));
    expect(row?.displayName).toBe('Mass Assignment Ltd');
    expect(row?.role).toBe('customer');
    expect(Number(row?.outstandingBalance)).toBe(0);
    expect(row?.defaultRevenueAccountId).toBeNull();
    expect(row?.defaultExpenseAccountId).toBeNull();
    expect(row?.taxExempt).not.toBe(true);
    expect(row?.currency).toBeNull();
    expect(row?.partyCode).toBeNull();
    expect(row?.billingAddress).toBeNull();
  });
});
