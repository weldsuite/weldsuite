/**
 * A US entity for the sales tax integration tests (pglite): an Austin LLC
 * registered in Texas, Washington and Florida with invented fixture rates
 * (never real-world rates, which go stale), a few customers and a vendor.
 * Test-only; nothing imports this in the worker.
 */

import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../../routes/accounting-entities';
import { salesTaxAgenciesRoutes } from '../../routes/sales-tax-agencies';
import { salesTaxJurisdictionsRoutes } from '../../routes/sales-tax-jurisdictions';
import { salesTaxZonesRoutes } from '../../routes/sales-tax-zones';

export const TEST_ENV = { DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32) };

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { code: string; message: string };
  pagination?: { totalCount: number; hasMore: boolean };
  text: string;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  perms?: string[];
  env?: Record<string, unknown>;
}

/** Calls a router the way the worker mounts it, as an admin of the entity. */
export function apiFor(db: Database, entityId?: () => string | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (mount: string, routes: Hono<any>, path: string, opts: ApiOptions = {}): Promise<ApiResult> => {
    const { request } = createTestApp(mount, routes, {
      context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
      env: { ...TEST_ENV, ...(opts.env ?? {}) },
    });
    const id = entityId?.();
    const res = await request(`${mount}${path}`, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(id ? { 'X-Accounting-Entity-Id': id } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = res.status === 204 ? '' : await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = text && isJson ? (JSON.parse(text) as { data?: any; error?: { code: string; message: string }; pagination?: { totalCount: number; hasMore: boolean } }) : {};
    return { status: res.status, data: json.data, error: json.error, pagination: json.pagination, text };
  };
}

/** One jurisdiction with its rate, added through the API. */
async function addJurisdiction(
  api: ReturnType<typeof apiFor>,
  agencyId: string,
  level: 'state' | 'county' | 'city' | 'district',
  name: string,
  rate: number,
  code?: string,
): Promise<string> {
  const res = await api('/api/sales-tax-jurisdictions', salesTaxJurisdictionsRoutes, '', {
    method: 'POST',
    body: { agencyId, level, name, code, reportingCode: code, rate: { rate, effectiveFrom: '2000-01-01' } },
  });
  if (res.status !== 201) throw new Error(`jurisdiction ${name}: ${res.text}`);
  return res.data.id as string;
}

async function addZone(
  api: ReturnType<typeof apiFor>,
  agencyId: string,
  name: string,
  jurisdictionIds: string[],
  postalCodes: string[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await api('/api/sales-tax-zones', salesTaxZonesRoutes, '', {
    method: 'POST',
    body: { agencyId, name, jurisdictionIds, postalCodes, ...extra },
  });
  if (res.status !== 201) throw new Error(`zone ${name}: ${res.text}`);
  return res.data.id as string;
}

export interface UsBooks {
  entityId: string;
  agencies: { tx: string; wa: string; fl: string };
  api: ReturnType<typeof apiFor>;
  /** Ledger account id by system role. */
  roleAccount: Map<string, string>;
}

const austin = { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' };

export async function seedUsBooks(db: Database): Promise<UsBooks> {
  let entityId: string | undefined;
  const api = apiFor(db, () => entityId);

  const created = await api('/api/accounting-entities', accountingEntitiesRoutes, '', {
    method: 'POST',
    body: {
      name: 'Acme Studio LLC',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      taxIdentifiers: { einOrSsn: '123456789' },
      address: austin,
    },
  });
  if (created.status !== 201) throw new Error(`entity: ${created.text}`);
  entityId = created.data.id as string;

  const agency = async (stateCode: string, extra: Record<string, unknown> = {}) => {
    const res = await api('/api/sales-tax-agencies', salesTaxAgenciesRoutes, '', {
      method: 'POST',
      body: { stateCode, registeredFrom: '2026-01-01', filingFrequency: 'quarterly', ...extra },
    });
    if (res.status !== 201) throw new Error(`agency ${stateCode}: ${res.text}`);
    return res.data.id as string;
  };
  const tx = await agency('TX');
  const wa = await agency('WA');
  const fl = await agency('FL');

  // Texas (origin-sourced): state 6.25 + city 1 + transit 1 at the seller's Austin address; Dallas at 8.25 too.
  const txState = await addJurisdiction(api, tx, 'state', 'Texas', 6.25, '48');
  const austinCity = await addJurisdiction(api, tx, 'city', 'Austin', 1, '4805000');
  const austinTransit = await addJurisdiction(api, tx, 'district', 'Capital Metro', 1, 'MTA-1');
  const dallasCity = await addJurisdiction(api, tx, 'city', 'Dallas', 1, '4819000');
  const dallasTransit = await addJurisdiction(api, tx, 'district', 'DART', 1, 'MTA-2');
  await addZone(api, tx, 'Austin', [txState, austinCity, austinTransit], ['78701'], { isOrigin: true });
  await addZone(api, tx, 'Dallas', [txState, dallasCity, dallasTransit], ['75201']);

  // Washington (destination-sourced): two zones with different combined rates.
  const waState = await addJurisdiction(api, wa, 'state', 'Washington', 6.5, '53');
  const seattle = await addJurisdiction(api, wa, 'city', 'Seattle', 3.6, '1700');
  const bellevue = await addJurisdiction(api, wa, 'city', 'Bellevue', 2.9, '0100');
  const soundTransit = await addJurisdiction(api, wa, 'district', 'Sound Transit', 1.1, 'RTA');
  await addZone(api, wa, 'Seattle', [waState, seattle], ['98101']);
  await addZone(api, wa, 'Bellevue', [waState, bellevue, soundTransit], ['98004']);

  // Florida: a state rate only.
  await addJurisdiction(api, fl, 'state', 'Florida', 6, '12');

  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  const roleAccount = new Map<string, string>();
  for (const account of accounts) {
    const role = (account.metadata as { systemRole?: string } | null)?.systemRole;
    if (role) roleAccount.set(role, account.id);
  }

  await db.insert(schema.parties).values([
    { id: 'pty_tx', displayName: 'Austin Customer', role: 'customer', billingAddress: { line1: '500 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } },
    { id: 'pty_dallas', displayName: 'Dallas Customer', role: 'customer', billingAddress: { line1: '2 Elm St', city: 'Dallas', state: 'TX', postalCode: '75201', country: 'US' } },
    { id: 'pty_ca', displayName: 'California Customer', role: 'customer', billingAddress: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postalCode: '94105', country: 'US' } },
    { id: 'pty_wa', displayName: 'Seattle Customer', role: 'customer', billingAddress: { line1: '1 Pike St', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US' } },
    { id: 'pty_fl', displayName: 'Reseller Inc', role: 'customer', billingAddress: { line1: '9 Palm Rd', city: 'Miami', state: 'FL', postalCode: '33101', country: 'US' } },
    { id: 'pty_vendor', displayName: 'Office Supply Co', role: 'supplier', billingAddress: { line1: '7 Vendor Way', city: 'Houston', state: 'TX', postalCode: '77001', country: 'US' } },
  ]);

  return { entityId, agencies: { tx, wa, fl }, api, roleAccount };
}
