/**
 * `GET /v1/legal-entities`: scope check, masked bank data (no account number
 * at all), registrations, and 405 on writes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';
import { maskIban } from '../routes/v1/legal-entities';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.legalEntities).values({
    id: 'ent_pub',
    name: 'Acme',
    legalName: 'Acme B.V.',
    jurisdictionCode: 'NL',
    baseCurrency: 'EUR',
    isDefault: true,
    ssnEncrypted: 'v1:secret-ssn',
    createdAt: now,
    updatedAt: now,
  } as typeof schema.legalEntities.$inferInsert);
  await db.insert(schema.legalEntityRegistrations).values({
    id: 'ler_pub',
    entityId: 'ent_pub',
    type: 'vat',
    number: 'NL123456789B01',
    isPrimary: true,
  } as typeof schema.legalEntityRegistrations.$inferInsert);
  await db.insert(schema.bankAccounts).values({
    id: 'ba_pub',
    entityId: 'ent_pub',
    name: 'Main',
    iban: 'NL91ABNA0417164300',
    accountNumberEncrypted: 'v1:secret-account-number',
    accountNumberLast4: '4300',
    routingNumber: '021000021',
  } as typeof schema.bankAccounts.$inferInsert);
}, 60_000);

describe('GET /v1/legal-entities', () => {
  it('masks the IBAN and returns no account number, routing number or ciphertext', async () => {
    const { request } = createExternalTestApp({ scopes: ['legal_entities:read'], tenantDb: db });
    for (const path of ['/v1/legal-entities', '/v1/legal-entities/ent_pub']) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { data: unknown };
      const entity = (Array.isArray(body.data) ? body.data[0] : body.data) as {
        id: string;
        registrations: { number: string }[];
        bankAccounts: { ibanMasked: string }[];
      };
      expect(entity.id).toBe('ent_pub');
      expect(entity.registrations.map((r) => r.number)).toEqual(['NL123456789B01']);
      expect(entity.bankAccounts[0]?.ibanMasked).toBe('**************4300');
      for (const secret of ['NL91ABNA0417164300', 'secret-account-number', 'secret-ssn', '021000021', 'accountNumber']) {
        expect(text, `${path} leaks ${secret}`).not.toContain(secret);
      }
    }
  });

  it('needs the legal_entities:read scope', async () => {
    const { request } = createExternalTestApp({ scopes: ['accounting_entities:read'], tenantDb: db });
    expect((await request('/v1/legal-entities')).status).toBe(403);
    expect((await request('/v1/legal-entities/ent_pub')).status).toBe(403);
    const wildcard = createExternalTestApp({ scopes: ['legal_entities:*'], tenantDb: db });
    expect((await wildcard.request('/v1/legal-entities')).status).toBe(200);
  });

  it('answers 404 for an unknown id and 405 for writes', async () => {
    const { request } = createExternalTestApp({ scopes: ['*'], tenantDb: db });
    expect((await request('/v1/legal-entities/ent_nope')).status).toBe(404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request('/v1/legal-entities/ent_pub', { method, headers: { 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
      expect(res.status, method).toBe(405);
    }
  });

  it('maskIban keeps only the last four characters', () => {
    expect(maskIban('NL91 ABNA 0417 1643 00')).toBe('**************4300');
    expect(maskIban(null)).toBeNull();
  });
});
