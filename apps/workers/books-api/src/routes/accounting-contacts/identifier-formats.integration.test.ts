/**
 * A contact's VAT number has to fit its country ("BE0123" is refused) and an
 * IBAN needs its country's length and valid check digits ("NL00 BANK 1234" is
 * refused), on create and on update. Entity IBANs get the same check.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { accountingContactsRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function call(mount: string, routes: typeof accountingContactsRoutes, path: string, method: string, body?: unknown) {
  const { request } = createTestApp(mount, routes, {
    context: { permissions: permissions('*'), tenantDb: db },
  });
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const contacts = (path: string, method: string, body?: unknown) =>
  call('/api/accounting-contacts', accountingContactsRoutes, `/api/accounting-contacts${path}`, method, body);

const company = (overrides: Record<string, unknown> = {}) => ({
  name: 'Acme NV',
  companyName: 'Acme NV',
  role: 'customer',
  billingAddress: { line1: 'Rue 1', city: 'Brussels', postalCode: '1000', country: 'BE' },
  ...overrides,
});

async function message(res: Response): Promise<string> {
  const json = (await res.json()) as { error?: { message?: string } };
  return json.error?.message ?? '';
}

describe('contact VAT number format', () => {
  it('refuses BE0123, naming the country and an example', async () => {
    const res = await contacts('', 'POST', company({ vatNumber: 'BE0123' }));
    expect(res.status).toBe(400);
    expect(await message(res)).toMatch(/not a valid BE VAT number.*BE0123456789/);
  });

  it('refuses a number without prefix that does not fit the billing country', async () => {
    const res = await contacts('', 'POST', company({ vatNumber: '0123' }));
    expect(res.status).toBe(400);
  });

  it('stores a good one compact and upper-case, also when the prefix is left out', async () => {
    const prefixed = await contacts('', 'POST', company({ vatNumber: 'be 0123.456.789' }));
    expect(prefixed.status).toBe(201);
    expect(((await prefixed.json()) as { data: { vatNumber: string } }).data.vatNumber).toBe('BE0123456789');

    const bare = await contacts('', 'POST', company({ name: 'Bare NV', companyName: 'Bare NV', vatNumber: '0987654321' }));
    expect(bare.status).toBe(201);
    expect(((await bare.json()) as { data: { vatNumber: string } }).data.vatNumber).toBe('BE0987654321');
  });

  it('leaves a US tax id on a US contact alone', async () => {
    const res = await contacts('', 'POST', company({
      name: 'Texas LLC',
      companyName: 'Texas LLC',
      vatNumber: '12-3456789',
      billingAddress: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    }));
    expect(res.status).toBe(201);
  });

  it('checks an update against the stored country when the update sends no address', async () => {
    const created = await contacts('', 'POST', company({ name: 'Upd NV', companyName: 'Upd NV' }));
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const bad = await contacts(`/${id}`, 'PATCH', { vatNumber: 'BE0123' });
    expect(bad.status).toBe(400);
    const good = await contacts(`/${id}`, 'PATCH', { vatNumber: 'BE0123456789' });
    expect(good.status).toBe(200);
  });
});

describe('IBAN format', () => {
  it('refuses NL00 BANK 1234 on a contact', async () => {
    const res = await contacts('', 'POST', company({ name: 'Bank NV', companyName: 'Bank NV', iban: 'NL00 BANK 1234' }));
    expect(res.status).toBe(400);
    expect(await message(res)).toMatch(/not a valid IBAN/);
  });

  it('refuses wrong check digits and wrong length, accepts a real one', async () => {
    const checksum = await contacts('', 'POST', company({ name: 'C1 NV', companyName: 'C1 NV', iban: 'NL92ABNA0417164300' }));
    expect(checksum.status).toBe(400);
    expect(await message(checksum)).toMatch(/check digits/);
    const length = await contacts('', 'POST', company({ name: 'C2 NV', companyName: 'C2 NV', iban: 'NL91ABNA04171643000' }));
    expect(length.status).toBe(400);
    expect(await message(length)).toMatch(/18 characters/);
    const ok = await contacts('', 'POST', company({ name: 'C3 NV', companyName: 'C3 NV', iban: 'NL91 ABNA 0417 1643 00' }));
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { data: { iban: string } }).data.iban).toBe('NL91ABNA0417164300');
  });

  it('refuses a bad IBAN in the bank details of an entity', async () => {
    const res = await call('/api/accounting-entities', accountingEntitiesRoutes as never, '/api/accounting-entities', 'POST', {
      name: 'Bad IBAN BV',
      jurisdictionCode: 'NL',
      bankDetails: { iban: 'NL00 BANK 1234' },
    });
    expect(res.status).toBe(400);
  });
});
