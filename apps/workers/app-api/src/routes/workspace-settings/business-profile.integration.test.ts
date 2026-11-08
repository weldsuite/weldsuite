/**
 * The workspace business profile is the default legal entity
 * (docs/plans/legal-entities.md): `PUT /api/workspace-settings` writes the
 * legal fields through to it and `GET` reads them back from it.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  createLegalEntity,
  getDefaultLegalEntityRow,
  getRegistration,
  listRegistrations,
  updateLegalEntity,
} from '@weldsuite/core-domain/legal-entities';

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => holder.master,
}));

import { workspaceSettingsRoutes } from './index';

const ORG = 'org_bp';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
}, 180_000);

beforeEach(async () => {
  await db.delete(schema.legalEntityRegistrations);
  await db.delete(schema.legalEntities);
  await db.delete(schema.workspaceSettings);
  await master.delete(masterSchema.workspaces);
  await master.insert(masterSchema.workspaces).values({ id: 'ws_bp', clerkOrgId: ORG, name: 'Acme Workspace', slug: 'bp-acme' });
});

function app() {
  return createTestApp('/api/workspace-settings', workspaceSettingsRoutes, {
    context: { userId: 'user_admin', orgId: ORG, tenantDb: db, masterDb: master, permissions: permissions('*') },
  });
}

const put = (body: unknown) =>
  app().request('/api/workspace-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = async () => ((await app().request('/api/workspace-settings')).json() as Promise<{ data: Record<string, unknown> | null }>);

describe('business profile = default legal entity', () => {
  it('writes the legal fields through to the default entity and reads them back from it', async () => {
    const entity = await createLegalEntity(db, { name: 'Acme', jurisdictionCode: 'NL', baseCurrency: 'EUR' });

    const res = await put({
      legalName: 'Acme B.V.',
      tradingName: 'Acme',
      contactFirstName: 'Ada',
      email: 'billing@acme.example',
      phone: '+31 20 123 4567',
      addressLine1: 'Keizersgracht 1',
      city: 'Amsterdam',
      postalCode: '1015 AA',
      country: 'NL',
      vatNumber: 'NL123456789B01',
      registrationNumber: '12345678',
      logoUrl: 'https://cdn.example/logo.png',
      websiteUrl: 'https://acme.example',
    });
    expect(res.status).toBe(201);

    const row = await getDefaultLegalEntityRow(db);
    expect(row?.id).toBe(entity.id);
    expect(row).toMatchObject({ legalName: 'Acme B.V.', dba: 'Acme', jurisdictionCode: 'NL' });
    expect(row?.address).toMatchObject({ line1: 'Keizersgracht 1', city: 'Amsterdam', postalCode: '1015 AA', country: 'NL' });
    expect(row?.contact).toMatchObject({ email: 'billing@acme.example', phone: '+31 20 123 4567', website: 'https://acme.example' });
    expect(row?.contact?.contactPerson).toMatchObject({ firstName: 'Ada' });
    expect(row?.branding).toMatchObject({ logoUrl: 'https://cdn.example/logo.png' });
    expect((await getRegistration(db, entity.id, 'vat'))?.number).toBe('NL123456789B01');
    expect((await getRegistration(db, entity.id, 'company_registration'))?.number).toBe('12345678');

    // The entity is the source of truth: a change made there shows up in GET.
    await updateLegalEntity(db, entity.id, { legalName: 'Acme Group B.V.' });
    const read = (await get()).data;
    expect(read).toMatchObject({
      legalName: 'Acme Group B.V.',
      tradingName: 'Acme',
      addressLine1: 'Keizersgracht 1',
      country: 'NL',
      vatNumber: 'NL123456789B01',
      registrationNumber: '12345678',
      email: 'billing@acme.example',
    });

    // Clearing a field clears it on the entity and in the response.
    expect((await put({ phone: null, vatNumber: null })).status).toBe(200);
    expect((await getDefaultLegalEntityRow(db))?.contact?.phone).toBeUndefined();
    expect(await getRegistration(db, entity.id, 'vat')).toBeNull();
    expect((await get()).data).toMatchObject({ phone: null, vatNumber: null });
  });

  it('creates the default entity when none exists and the country is an ISO-2 code', async () => {
    const res = await put({
      legalName: 'Fresh Ltd',
      country: 'GB',
      city: 'London',
      vatNumber: 'GB123456789',
    });
    expect(res.status).toBe(201);
    const row = await getDefaultLegalEntityRow(db);
    expect(row).toMatchObject({ name: 'Fresh Ltd', legalName: 'Fresh Ltd', jurisdictionCode: 'GB', baseCurrency: 'GBP', isDefault: true });
    expect(row?.address).toMatchObject({ city: 'London', country: 'GB' });
    expect((await listRegistrations(db, row!.id)).map((r) => [r.type, r.number, r.isPrimary])).toEqual([['vat', 'GB123456789', true]]);
  });

  it('uses the workspace currency for a new entity and the workspace name when the save names no company', async () => {
    const res = await put({ currency: 'USD', country: 'US', city: 'Austin' });
    expect(res.status).toBe(201);
    expect(await getDefaultLegalEntityRow(db)).toMatchObject({ name: 'Acme Workspace', baseCurrency: 'USD', jurisdictionCode: 'US' });
  });

  it('skips the entity when the country is not an ISO-2 code, and still saves the settings', async () => {
    const res = await put({ legalName: 'Somewhere Inc', country: 'Netherlands' });
    expect(res.status).toBe(201);
    expect(await getDefaultLegalEntityRow(db)).toBeNull();
    expect((await get()).data).toMatchObject({ legalName: 'Somewhere Inc', country: 'Netherlands' });
  });

  it('refuses a new country once WeldBooks has postings for the default entity, and saves nothing', async () => {
    const entity = await createLegalEntity(db, { name: 'Acme', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
    await db.insert(schema.accountingEntitySettings).values({ entityId: entity.id });
    await db.insert(schema.journalEntries).values({ id: 'je_bp', entityId: entity.id, date: new Date('2026-01-15'), status: 'posted' });
    try {
      const refused = await put({ legalName: 'Acme België', country: 'BE' });
      expect(refused.status).toBe(409);
      expect((await getDefaultLegalEntityRow(db))?.jurisdictionCode).toBe('NL');
      expect((await get()).data).toBeNull();

      // The same country (any case) is not a change.
      expect((await put({ legalName: 'Acme B.V.', country: 'nl' })).status).toBe(201);
      expect(await getDefaultLegalEntityRow(db)).toMatchObject({ legalName: 'Acme B.V.', jurisdictionCode: 'NL' });
    } finally {
      await db.delete(schema.journalEntries);
      await db.delete(schema.accountingEntitySettings);
    }
  });

  it('leaves the default entity alone when a save carries no legal field', async () => {
    const entity = await createLegalEntity(db, { name: 'Acme', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
    expect((await put({ timezone: 'Europe/Amsterdam', theme: 'dark' })).status).toBe(201);
    expect((await getDefaultLegalEntityRow(db))?.updatedAt.getTime()).toBe(entity.updatedAt.getTime());
  });
});
