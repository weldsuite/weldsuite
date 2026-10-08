/**
 * Cross-route safety sweeps for this worker (the same checks app-api runs, from
 * @weldsuite/worker-kit/testing/sweeps):
 *
 * - entity-event coverage: every core-CRUD mutation (`post('/')`,
 *   `patch|put('/:id')`, `delete('/:id')`) publishes an entity event;
 * - auth gates: standard CRUD calls answer 403 without their permission;
 * - list endpoints: GET / answers 200 with the list envelope on an empty tenant.
 *
 * Add a route to AUTH_CASES / LIST_CASES when it follows the standard shape,
 * and to EXEMPT_ROUTES (with a one-line reason) when it has nothing to publish.
 */

import { describe, expect, it } from 'vitest';
import {
  authGateStatuses,
  findMissingEntityEvents,
  listEndpointResult,
  type AuthGateCase,
  type ListSweepCase,
} from '@weldsuite/worker-kit/testing/sweeps';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Env, Variables } from '../types';
import { bankAccountsRoutes } from './bank-accounts';
import { bankDepositsRoutes } from './bank-deposits';
import { bankReconciliationsRoutes } from './bank-reconciliations';
import { billsRoutes } from './bills';
import { exemptionCertificatesRoutes } from './exemption-certificates';
import { fiscalPeriodsRoutes } from './fiscal-periods';
import { fixedAssetsRoutes } from './fixed-assets';
import { form1099FilingsRoutes } from './form-1099/filings';
import { invoicesRoutes } from './invoices';
import { paymentRunsRoutes } from './payment-runs';
import { payrollConnectionsRoutes, payrollImportsRoutes } from './payroll';
import { paymentsRoutes } from './payments';
import { salesTaxAgenciesRoutes } from './sales-tax-agencies';
import { salesTaxJurisdictionsRoutes } from './sales-tax-jurisdictions';
import { salesTaxRulesRoutes } from './sales-tax-rules';
import { salesTaxZonesRoutes } from './sales-tax-zones';
import { taxReturnsRoutes } from './tax-returns';
import { w9RequestsRoutes } from './w9-requests';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // Accounting read-only / singleton routes — no core-CRUD mutations.
  // accounting-settings: singleton PUT / (not PUT /:id); no post('/') create.
  // accounting-reports, accounting-dashboard: read-only aggregates only.
  'accounting-settings',
  'accounting-reports',
  'accounting-dashboard',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/bills', router: billsRoutes, prefix: 'bills' },
  // Sales Tax Center: filing and payment need taxes:file on top (sub-routes, not the standard CRUD calls).
  { mount: '/api/tax-returns', router: taxReturnsRoutes, prefix: 'taxes' },
  // US sales tax setup: agencies, the manual engine's jurisdictions, zones and rules, exemption certificates.
  { mount: '/api/sales-tax-agencies', router: salesTaxAgenciesRoutes, prefix: 'taxes' },
  { mount: '/api/sales-tax-jurisdictions', router: salesTaxJurisdictionsRoutes, prefix: 'taxes' },
  { mount: '/api/sales-tax-zones', router: salesTaxZonesRoutes, prefix: 'taxes' },
  { mount: '/api/sales-tax-rules', router: salesTaxRulesRoutes, prefix: 'taxes' },
  { mount: '/api/exemption-certificates', router: exemptionCertificatesRoutes, prefix: 'taxes' },
  { mount: '/api/fixed-assets', router: fixedAssetsRoutes, prefix: 'accounts' },
  // Payroll: imports are created through POST /csv (not POST /) and reversed by DELETE; never patched.
  { mount: '/api/payroll/imports', router: payrollImportsRoutes, prefix: 'journal', skipPost: true, skipPatch: true },
  { mount: '/api/payroll/connections', router: payrollConnectionsRoutes, prefix: 'journal', skipPatch: true },
  { mount: '/api/bank-accounts', router: bankAccountsRoutes, prefix: 'banking' },
  { mount: '/api/bank-deposits', router: bankDepositsRoutes, prefix: 'banking' },
  { mount: '/api/bank-reconciliations', router: bankReconciliationsRoutes, prefix: 'banking' },
  { mount: '/api/payments', router: paymentsRoutes, prefix: 'banking', skipPatch: true },
  // Runs are planned and edited with banking:create and approved with banking:manage; reads need bills:read.
  { mount: '/api/payment-runs', router: paymentRunsRoutes, prefix: 'banking' },
  { mount: '/api/form-1099/filings', router: form1099FilingsRoutes, prefix: 'taxes' },
  // POST is gated by suppliers:update or taxes:create; a request is cancelled, not patched or deleted.
  { mount: '/api/w9-requests', router: w9RequestsRoutes, prefix: 'taxes', skipPatch: true, skipDelete: true },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/invoices', router: invoicesRoutes, permission: 'invoices:read' },
  { mount: '/api/tax-returns', router: taxReturnsRoutes, permission: 'taxes:read' },
  { mount: '/api/sales-tax-agencies', router: salesTaxAgenciesRoutes, permission: 'taxes:read' },
  { mount: '/api/sales-tax-jurisdictions', router: salesTaxJurisdictionsRoutes, permission: 'taxes:read' },
  { mount: '/api/sales-tax-zones', router: salesTaxZonesRoutes, permission: 'taxes:read' },
  { mount: '/api/sales-tax-rules', router: salesTaxRulesRoutes, permission: 'taxes:read' },
  { mount: '/api/exemption-certificates', router: exemptionCertificatesRoutes, permission: 'taxes:read' },
  { mount: '/api/bills', router: billsRoutes, permission: 'bills:read' },
  { mount: '/api/fixed-assets', router: fixedAssetsRoutes, permission: 'accounts:read' },
  { mount: '/api/payroll/imports', router: payrollImportsRoutes, permission: 'journal:read' },
  { mount: '/api/payroll/connections', router: payrollConnectionsRoutes, permission: 'journal:read' },
  { mount: '/api/fiscal-periods', router: fiscalPeriodsRoutes, permission: 'reports:read' },
  { mount: '/api/bank-accounts', router: bankAccountsRoutes, permission: 'banking:read' },
  { mount: '/api/bank-deposits', router: bankDepositsRoutes, permission: 'banking:read' },
  { mount: '/api/bank-reconciliations', router: bankReconciliationsRoutes, permission: 'banking:read' },
  { mount: '/api/payments', router: paymentsRoutes, permission: 'banking:read' },
  { mount: '/api/payment-runs', router: paymentRunsRoutes, permission: 'bills:read' },
  { mount: '/api/form-1099/filings', router: form1099FilingsRoutes, permission: 'taxes:read' },
  { mount: '/api/w9-requests', router: w9RequestsRoutes, permission: 'taxes:read' },
];

describe('entity-event coverage', () => {
  const report = findMissingEntityEvents(ROUTES_DIR, EXEMPT_ROUTES);

  it('every core-CRUD mutation handler publishes an entity event', () => {
    expect(report.failures, `\n${report.failures.join('\n')}\n`).toEqual([]);
  });

  it('exemptions all reference real route directories', () => {
    expect(report.staleExemptions).toEqual([]);
  });
});

describe.skipIf(AUTH_CASES.length === 0).each(AUTH_CASES)('$mount · auth gates', (c) => {
  it('refuses every standard CRUD call without its permission', async () => {
    for (const r of await authGateStatuses(c)) expect(r.status, r.label).toBe(403);
  });
});

describe.skipIf(LIST_CASES.length === 0).each(LIST_CASES)('$mount · GET / (list endpoint sweep)', (c) => {
  // 60 s: the first case boots pglite (WASM Postgres) for this test process.
  it('returns 200 with the list envelope against an empty tenant', async () => {
    const { db } = await createPgliteDb();
    const r = await listEndpointResult(c, db);
    expect(r.status).toBe(200);
    expect(r.envelopeOk).toBe(true);
  }, 60_000);
});
