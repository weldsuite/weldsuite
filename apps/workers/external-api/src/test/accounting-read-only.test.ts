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
import { listWithCursor } from '../lib/list-helpers';

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

describe('external-api · ciphertext columns never leave the worker', () => {
  const now = new Date();
  const entityId = 'ent_ct_001';
  const bankAccountId = 'bka_ct_001';
  const partyId = 'pty_ct_001';

  // Distinct, greppable markers: if any of these shows up in a response or an
  // event, a ciphertext column was selected and serialised.
  const SSN_BLOB = 'ct-ssn-blob-3f9a';
  const CREDS_BLOB = 'ct-sales-tax-creds-blob-71bc';
  const ACCOUNT_BLOB = 'ct-account-number-blob-b02e';
  const PARTY_BLOB = 'ct-party-tin-blob-9d44';
  const MARKERS = [SSN_BLOB, CREDS_BLOB, ACCOUNT_BLOB, PARTY_BLOB];
  const COLUMN_NAMES = ['ssnEncrypted', 'salesTaxCredentialsEncrypted', 'accountNumberEncrypted', 'sensitiveEncrypted'];

  beforeAll(async () => {
    await db.insert(schema.entities).values({
      id: entityId,
      name: 'Ciphertext LLC',
      jurisdictionCode: 'US',
      baseCurrency: 'USD',
      locale: 'en-US',
      isActive: true,
      ssnEncrypted: SSN_BLOB,
      ssnLast4: '1234',
      salesTaxCredentialsEncrypted: CREDS_BLOB,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.bankAccounts).values({
      id: bankAccountId,
      entityId,
      name: 'Operating',
      accountNumberEncrypted: ACCOUNT_BLOB,
      accountNumberLast4: '6789',
      routingNumber: '021000021',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.parties).values({
      id: partyId,
      displayName: 'Vendor With A TIN',
      role: 'supplier',
      tinType: 'ein',
      tinLast4: '4321',
      sensitiveEncrypted: PARTY_BLOB,
      createdAt: now,
      updatedAt: now,
    });
  }, 30_000);

  const request = (scopes: string[]) => createExternalTestApp({ scopes, tenantDb: db }).request;

  function expectNoCiphertext(text: string, context: string) {
    for (const marker of MARKERS) expect(text, `${context}: ${marker}`).not.toContain(marker);
    for (const column of COLUMN_NAMES) expect(text, `${context}: ${column}`).not.toContain(column);
  }

  it('GET /v1/accounting-entities leaves out the SSN and the sales tax credentials', async () => {
    const list = await request(['accounting_entities:read'])('/v1/accounting-entities');
    expect(list.status).toBe(200);
    const listText = await list.text();
    expectNoCiphertext(listText, 'list');
    const row = (JSON.parse(listText) as { data: Array<Record<string, unknown>> }).data.find((e) => e.id === entityId);
    expect(row, 'the seeded entity is listed').toBeDefined();
    expect(row!.ssnLast4).toBe('1234');

    const one = await request(['accounting_entities:read'])(`/v1/accounting-entities/${entityId}`);
    expect(one.status).toBe(200);
    const oneText = await one.text();
    expectNoCiphertext(oneText, 'get');
    expect((JSON.parse(oneText) as { data: Record<string, unknown> }).data.ssnLast4).toBe('1234');
  });

  it('GET /v1/bank-accounts leaves out the account number blob and keeps the last four', async () => {
    const list = await request(['bank_accounts:read'])(`/v1/bank-accounts?entityId=${entityId}`);
    expect(list.status).toBe(200);
    const listText = await list.text();
    expectNoCiphertext(listText, 'list');
    const [row] = (JSON.parse(listText) as { data: Array<Record<string, unknown>> }).data;
    expect(row!.id).toBe(bankAccountId);
    expect(row!.accountNumberLast4).toBe('6789');

    const one = await request(['bank_accounts:read'])(`/v1/bank-accounts/${bankAccountId}`);
    expect(one.status).toBe(200);
    const oneText = await one.text();
    expectNoCiphertext(oneText, 'get');
    expect((JSON.parse(oneText) as { data: Record<string, unknown> }).data.accountNumberLast4).toBe('6789');
  });

  it('accounting contacts never return the party ciphertext, on read or write, and a write leaves it stored', async () => {
    const scopes = ['accounting_contacts:read', 'accounting_contacts:write'];

    const list = await request(scopes)('/v1/accounting-contacts');
    expect(list.status).toBe(200);
    const listText = await list.text();
    expectNoCiphertext(listText, 'list');
    const row = (JSON.parse(listText) as { data: Array<Record<string, unknown>> }).data.find((p) => p.id === partyId);
    expect(row, 'the seeded party is listed').toBeDefined();
    expect(row!.tinLast4).toBe('4321');

    const one = await request(scopes)(`/v1/accounting-contacts/${partyId}`);
    expect(one.status).toBe(200);
    expectNoCiphertext(await one.text(), 'get');

    const patched = await request(scopes)(`/v1/accounting-contacts/${partyId}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Vendor With A TIN, Renamed' }),
    });
    expect(patched.status).toBe(200);
    expectNoCiphertext(await patched.text(), 'patch');

    const created = await request(scopes)('/v1/accounting-contacts', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Brand New Vendor', type: 'supplier' }),
    });
    expect(created.status).toBe(201);
    expectNoCiphertext(await created.text(), 'create');

    // Never reading the column must not mean clearing it.
    const [stored] = await db.select().from(schema.parties).where(eq(schema.parties.id, partyId));
    expect(stored?.sensitiveEncrypted).toBe(PARTY_BLOB);
    expect(stored?.displayName).toBe('Vendor With A TIN, Renamed');
  });

  it('accounting contact events do not carry the party ciphertext either', async () => {
    const sent: unknown[] = [];
    const { app, env } = createExternalTestApp({
      scopes: ['accounting_contacts:write'],
      tenantDb: db,
      env: { ENTITY_EVENTS: { send: async (message: unknown) => void sent.push(message) } as never },
    });
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException: () => undefined,
    };

    const res = await app.request(
      `/v1/accounting-contacts/${partyId}`,
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed Again' }) },
      env as never,
      executionCtx as never,
    );
    expect(res.status).toBe(200);
    await Promise.all(pending);

    expect(sent).toHaveLength(1);
    expectNoCiphertext(JSON.stringify(sent), 'entity event');
  });

  it('the generic list helper drops ciphertext columns even when a route does not ask', async () => {
    const result = await listWithCursor({ db, table: schema.parties });
    const rows = result.data as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect('sensitiveEncrypted' in row).toBe(false);
    expect(rows.some((r) => r.id === partyId)).toBe(true);
  });
});
