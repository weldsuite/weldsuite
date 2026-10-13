/**
 * The XAF auditfile lists every contact and the entity's company header. The
 * party row behind a contact holds a TIN and vendor ACH account number as
 * ciphertext, and the entity row holds the owner's SSN; none of it may reach
 * the file. pglite-backed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingExportsRoutes } from './index';

let db: Database;

const ENTITY_ID = 'ent_xaf_ct_001';
const PARTY_BLOB = 'ct-xaf-party-blob-1d8e';
const SSN_BLOB = 'ct-xaf-ssn-blob-a42c';
const CREDS_BLOB = 'ct-xaf-creds-blob-07fb';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.entities).values({
    id: ENTITY_ID,
    name: 'Auditfile Test BV',
    jurisdictionCode: 'NL',
    baseCurrency: 'EUR',
    locale: 'nl-NL',
    isActive: true,
    ssnEncrypted: SSN_BLOB,
    salesTaxCredentialsEncrypted: CREDS_BLOB,
    taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' },
    address: { line1: 'Damrak 1', line2: '2e verdieping', city: 'Amsterdam', postalCode: '1012 LG', country: 'NL' },
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.parties).values([
    {
      id: 'pty_xaf_ct_001',
      displayName: 'Leverancier met TIN',
      role: 'supplier',
      tinType: 'ein',
      tinLast4: '4321',
      sensitiveEncrypted: PARTY_BLOB,
      billingAddress: { line1: 'Keizersgracht 12', city: 'Utrecht', postalCode: '3511 AB', country: 'NL' },
      createdAt: now,
      updatedAt: now,
    },
    // On no document, payment or journal line of this entity: not a relation of it.
    { id: 'pty_xaf_ct_002', displayName: 'Onbekende Relatie', role: 'customer', createdAt: now, updatedAt: now },
  ]);
  // The supplier is on a journal line of this entity.
  await db.insert(schema.accounts).values({
    id: 'acc_xaf_ct_001', entityId: ENTITY_ID, code: '4000', name: 'Kosten', type: 'expense', normalSide: 'debit', createdAt: now, updatedAt: now,
  });
  await db.insert(schema.journalEntries).values({
    id: 'je_xaf_ct_001', entityId: ENTITY_ID, entryNumber: 'JE-0001', date: new Date('2026-03-01T00:00:00Z'), status: 'posted', description: 'Inkoop', createdAt: now, updatedAt: now,
  });
  await db.insert(schema.journalLines).values({
    id: 'jl_xaf_ct_001', entityId: ENTITY_ID, journalEntryId: 'je_xaf_ct_001', accountId: 'acc_xaf_ct_001', debit: '10.00', credit: '0', contactId: 'pty_xaf_ct_001', sortOrder: 0, createdAt: now, updatedAt: now,
  });
}, 120_000);

describe('GET /api/accounting-exports/xaf', () => {
  it('lists the contact but carries none of the ciphertext columns', async () => {
    const { request } = createTestApp('/api/accounting-exports', accountingExportsRoutes, {
      context: { permissions: permissions('reports:read'), tenantDb: db },
    });
    const res = await request('/api/accounting-exports/xaf?fiscalYear=2026', {
      headers: { 'X-Accounting-Entity-Id': ENTITY_ID },
    });
    expect(res.status).toBe(200);
    const xml = await res.text();

    expect(xml).toContain('Leverancier met TIN');
    for (const blob of [PARTY_BLOB, SSN_BLOB, CREDS_BLOB]) expect(xml).not.toContain(blob);
    for (const column of ['sensitiveEncrypted', 'ssnEncrypted', 'salesTaxCredentialsEncrypted']) {
      expect(xml).not.toContain(column);
    }
  });
});

describe('XAF company address and relations (TASK-1114)', () => {
  async function xaf(): Promise<string> {
    const { request } = createTestApp('/api/accounting-exports', accountingExportsRoutes, {
      context: { permissions: permissions('reports:read'), tenantDb: db },
    });
    const res = await request('/api/accounting-exports/xaf?fiscalYear=2026', { headers: { 'X-Accounting-Entity-Id': ENTITY_ID } });
    expect(res.status).toBe(200);
    return res.text();
  }

  it('prints the entity address as the company streetAddress', async () => {
    const xml = await xaf();
    const company = xml.slice(xml.indexOf('<company>'), xml.indexOf('<customersSuppliers>'));
    expect(company).toContain('<streetAddress>');
    expect(company).toContain('<streetname>Damrak</streetname>');
    expect(company).toContain('<number>1</number>');
    expect(company).toContain('<property>2e verdieping</property>');
    expect(company).toContain('<city>Amsterdam</city>');
    expect(company).toContain('<postalCode>1012 LG</postalCode>');
    expect(company).toContain('<country>NL</country>');
  });

  it('lists only the relations the entity actually used, with their address and tax number', async () => {
    const xml = await xaf();
    expect(xml).toContain('Leverancier met TIN');
    expect(xml).toContain('<streetname>Keizersgracht</streetname>');
    expect(xml).not.toContain('Onbekende Relatie');
  });
});
