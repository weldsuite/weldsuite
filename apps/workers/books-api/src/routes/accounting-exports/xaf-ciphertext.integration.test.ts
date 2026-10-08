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
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.parties).values({
    id: 'pty_xaf_ct_001',
    displayName: 'Leverancier met TIN',
    role: 'supplier',
    tinType: 'ein',
    tinLast4: '4321',
    sensitiveEncrypted: PARTY_BLOB,
    createdAt: now,
    updatedAt: now,
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
