/**
 * Smoke test for WeldBooks route registration — no database required.
 */

import { describe, it, expect } from 'vitest';
import { createExternalTestApp } from './harness';

const ACCOUNTING_ENDPOINTS = [
  '/v1/accounting-contacts',
  '/v1/accounting-documents',
  '/v1/accounting-entities',
  '/v1/accounting-settings',
  '/v1/bank-accounts',
  '/v1/bank-transactions',
  '/v1/bills',
  '/v1/fiscal-periods',
  '/v1/fx-rates',
  '/v1/gl-accounts',
  '/v1/icp-declarations',
  '/v1/invoices',
  '/v1/journal-entries',
  '/v1/payments',
  '/v1/reconciliation-rules',
  '/v1/recurring-invoices',
  '/v1/tax-rates',
  '/v1/vat-returns',
];

describe('external-api · accounting routes', () => {
  it('registers all WeldBooks endpoints on GET /v1', async () => {
    const { request } = createExternalTestApp({ scopes: ['*'] });
    const res = await request('/v1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { endpoints: string[] } };
    for (const endpoint of ACCOUNTING_ENDPOINTS) {
      expect(body.data.endpoints).toContain(endpoint);
    }
  });

  it('returns 403 for accounting list without scope', async () => {
    const { request } = createExternalTestApp({ scopes: ['companies:read'] });
    const res = await request('/v1/invoices');
    expect(res.status).toBe(403);
  });
});
