import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ExemptionCertificate,
  SalesTaxAgency,
  SalesTaxJurisdiction,
  SalesTaxJurisdictionRate,
  SalesTaxTaxabilityRule,
  SalesTaxZone,
} from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { buildManualEngineData, loadCustomerCertificates, loadSalesTaxContext, toCertificateRef, toRegistration } from './load';
import { fakeFetch } from './test-http';
import { line, request } from './test-fixtures';
import { SalesTaxEngineError } from './types';

const now = new Date('2026-03-15T12:00:00Z');

function agencyRow(extra: Partial<SalesTaxAgency> = {}): SalesTaxAgency {
  return {
    id: 'ag_tx',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    entityId: 'ent_load',
    stateCode: 'TX',
    level: 'state',
    localJurisdictionCode: null,
    name: 'Texas Comptroller',
    registrationNumber: '32-0000000',
    registeredFrom: '2024-01-01',
    registeredUntil: null,
    status: 'registered',
    filingFrequency: 'quarterly',
    firstPeriodStart: null,
    dueDay: 20,
    reportingBasis: 'accrual',
    sstMember: false,
    liabilityAccountId: null,
    useTaxAccountId: null,
    portalUrl: null,
    providerRegistrationRef: null,
    notes: null,
    ...extra,
  };
}

function jurisdictionRow(id: string, level: string, name: string, extra: Partial<SalesTaxJurisdiction> = {}): SalesTaxJurisdiction {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    entityId: 'ent_load',
    agencyId: 'ag_tx',
    stateCode: 'TX',
    level,
    code: null,
    name,
    reportingCode: null,
    isActive: true,
    ...extra,
  };
}

function rateRow(jurisdictionId: string, rate: string, effectiveFrom: string, effectiveTo: string | null = null): SalesTaxJurisdictionRate {
  return {
    id: `r_${jurisdictionId}_${effectiveFrom}`,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    entityId: 'ent_load',
    jurisdictionId,
    rate,
    effectiveFrom,
    effectiveTo,
  };
}

describe('mapping rows to engine data', () => {
  it('maps an agency to a registration', () => {
    expect(toRegistration(agencyRow())).toEqual({
      agencyId: 'ag_tx',
      stateCode: 'TX',
      level: 'state',
      localJurisdictionCode: null,
      status: 'registered',
      registeredFrom: '2024-01-01',
      registeredUntil: null,
    });
    expect(toRegistration(agencyRow({ level: 'local', stateCode: 'co', status: 'weird' })).level).toBe('local');
    expect(toRegistration(agencyRow({ stateCode: 'co' })).stateCode).toBe('CO');
    expect(toRegistration(agencyRow({ status: 'weird' })).status).toBe('monitoring');
  });

  it('builds manual engine data with numeric rates grouped per jurisdiction', () => {
    const zone: SalesTaxZone = {
      id: 'z1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      entityId: 'ent_load',
      agencyId: 'ag_tx',
      stateCode: 'TX',
      name: 'Fixtown',
      jurisdictionIds: ['j_state', 'j_city'],
      postalCodes: ['78701', { from: '78702', to: '78710' }],
      isOrigin: true,
      priority: 5,
    };
    const rule: SalesTaxTaxabilityRule = {
      id: 'rule1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      entityId: 'ent_load',
      agencyId: 'ag_tx',
      taxCode: 'saas',
      taxable: true,
      taxablePercent: '80.0000',
      appliesToUse: 'business',
      rateOverride: '3.0000',
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      notes: null,
    };
    const data = buildManualEngineData({
      jurisdictions: [jurisdictionRow('j_state', 'state', 'Texas', { code: '48' }), jurisdictionRow('j_city', 'city', 'Fixtown', { reportingCode: 'TX-1' })],
      rates: [rateRow('j_state', '5.0000', '2020-01-01', '2025-12-31'), rateRow('j_state', '5.2500', '2026-01-01'), rateRow('j_city', '1.5000', '2020-01-01')],
      zones: [zone],
      rules: [rule],
    });

    expect(data.jurisdictions[0]).toMatchObject({
      id: 'j_state',
      code: '48',
      level: 'state',
      stateCode: 'TX',
      rates: [
        { rate: 5, effectiveFrom: '2020-01-01', effectiveTo: '2025-12-31' },
        { rate: 5.25, effectiveFrom: '2026-01-01', effectiveTo: null },
      ],
    });
    expect(data.jurisdictions[1]).toMatchObject({ reportingCode: 'TX-1', rates: [{ rate: 1.5 }] });
    expect(data.zones[0]).toMatchObject({
      jurisdictionIds: ['j_state', 'j_city'],
      postalCodes: ['78701', { from: '78702', to: '78710' }],
      isOrigin: true,
      priority: 5,
    });
    expect(data.rules[0]).toEqual({
      agencyId: 'ag_tx',
      taxCode: 'saas',
      taxable: true,
      taxablePercent: 80,
      appliesToUse: 'business',
      rateOverride: 3,
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
    });
  });

  it('maps a certificate row, keeping an unknown reason as other', () => {
    const row: ExemptionCertificate = {
      id: 'c1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      entityId: 'ent_load',
      partyId: 'p1',
      states: ['fl', 'TX'],
      reason: 'sovereign',
      certificateNumber: 'N-1',
      form: 'mtc_uniform',
      issuedOn: '2026-01-05',
      expiresOn: null,
      blanket: true,
      invoiceId: null,
      documentId: null,
      status: 'valid',
      receivedOn: null,
      notes: null,
    };
    expect(toCertificateRef(row, '2026-02-01')).toEqual({
      id: 'c1',
      states: ['FL', 'TX'],
      reason: 'other',
      certificateNumber: 'N-1',
      form: 'mtc_uniform',
      issuedOn: '2026-01-05',
      expiresOn: null,
      blanket: true,
      invoiceId: null,
      status: 'valid',
      lastUsedOn: '2026-02-01',
    });
    expect(toCertificateRef({ ...row, reason: 'resale', status: 'weird' }).status).toBe('pending');
  });
});

describe('loadSalesTaxContext (pglite)', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const handle = await createPgliteDb();
    db = handle.db;
    close = handle.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  async function seedEntity(id: string, extra: Partial<typeof schema.entities.$inferInsert> = {}) {
    await db.insert(schema.entities).values({
      id,
      name: 'Load Test LLC',
      jurisdictionCode: 'US',
      baseCurrency: 'USD',
      locale: 'en-US',
      ...extra,
    });
  }

  async function seedManual(entityId: string) {
    await db.insert(schema.salesTaxAgencies).values([
      { id: `${entityId}_tx`, entityId, stateCode: 'TX', name: 'Texas Comptroller', status: 'registered', registeredFrom: '2024-01-01' },
      { id: `${entityId}_gone`, entityId, stateCode: 'CA', name: 'Deleted agency', status: 'registered', deletedAt: new Date() },
    ]);
    await db.insert(schema.salesTaxJurisdictions).values([
      { id: `${entityId}_j_state`, entityId, agencyId: `${entityId}_tx`, stateCode: 'TX', level: 'state', name: 'Texas', code: '48' },
      { id: `${entityId}_j_city`, entityId, agencyId: `${entityId}_tx`, stateCode: 'TX', level: 'city', name: 'Fixtown' },
      { id: `${entityId}_j_off`, entityId, agencyId: `${entityId}_tx`, stateCode: 'TX', level: 'district', name: 'Switched off', isActive: false },
      { id: `${entityId}_j_del`, entityId, agencyId: `${entityId}_tx`, stateCode: 'TX', level: 'district', name: 'Deleted', deletedAt: new Date() },
    ]);
    await db.insert(schema.salesTaxJurisdictionRates).values([
      { id: `${entityId}_r1`, entityId, jurisdictionId: `${entityId}_j_state`, rate: '5.0000', effectiveFrom: '2020-01-01' },
      { id: `${entityId}_r2`, entityId, jurisdictionId: `${entityId}_j_city`, rate: '1.5000', effectiveFrom: '2020-01-01' },
      { id: `${entityId}_r3`, entityId, jurisdictionId: `${entityId}_j_city`, rate: '9.9999', effectiveFrom: '2020-01-01', deletedAt: new Date() },
    ]);
    await db.insert(schema.salesTaxZones).values({
      id: `${entityId}_z1`,
      entityId,
      agencyId: `${entityId}_tx`,
      stateCode: 'TX',
      name: 'Fixtown',
      jurisdictionIds: [`${entityId}_j_state`, `${entityId}_j_city`],
      postalCodes: ['78701'],
      isOrigin: true,
    });
    await db.insert(schema.salesTaxTaxabilityRules).values({
      id: `${entityId}_rule1`,
      entityId,
      agencyId: `${entityId}_tx`,
      taxCode: 'saas',
      taxablePercent: '80',
      effectiveFrom: '2020-01-01',
    });
  }

  it('loads a manual engine from the tables and calculates with it', async () => {
    await seedEntity('ent_manual');
    await seedManual('ent_manual');
    const ctx = await loadSalesTaxContext(db, 'ent_manual', { decrypt: async () => '' });

    expect(ctx.engineId).toBe('manual');
    expect(ctx.engine.id).toBe('manual');
    expect(ctx.agencies.map((a) => a.id)).toEqual(['ent_manual_tx']);
    expect(ctx.registrations).toEqual([
      {
        agencyId: 'ent_manual_tx',
        stateCode: 'TX',
        level: 'state',
        localJurisdictionCode: null,
        status: 'registered',
        registeredFrom: '2024-01-01',
        registeredUntil: null,
      },
    ]);

    const result = await ctx.engine.calculate(
      request({
        entityId: 'ent_manual',
        registrations: ctx.registrations,
        lines: [line('a', 100), line('b', 100, { taxCode: 'saas' })],
      }),
    );
    expect(result.warnings).toEqual([]);
    // 5% + 1.5%: the switched-off and deleted jurisdictions and the deleted rate don't count.
    expect(result.lines[0].tax).toBe(6.5);
    expect(result.lines[0].details.map((d) => d.jurisdictionName)).toEqual(['Texas', 'Fixtown']);
    expect(result.lines[1]).toMatchObject({ taxableAmount: 80, nonTaxableAmount: 20, tax: 5.2 });
  }, 60_000);

  it('defaults to the manual engine and reads the engine of the entity', async () => {
    await seedEntity('ent_default', { salesTaxEngine: null });
    const ctx = await loadSalesTaxContext(db, 'ent_default', { decrypt: async () => '' });
    expect(ctx.engineId).toBe('manual');
    expect(ctx.registrations).toEqual([]);
  });

  it('loads Stripe Tax with the decrypted key', async () => {
    await seedEntity('ent_stripe', { salesTaxEngine: 'stripe_tax', salesTaxCredentialsEncrypted: 'blob-1' });
    const decrypted: string[] = [];
    const http = fakeFetch([{ json: { data: [], has_more: false } }]);
    const ctx = await loadSalesTaxContext(db, 'ent_stripe', {
      decrypt: async (blob) => {
        decrypted.push(blob);
        return JSON.stringify({ apiKey: 'rk_live_fixture' });
      },
      fetch: http.fetch,
    });
    expect(decrypted).toEqual(['blob-1']);
    expect(ctx.engineId).toBe('stripe_tax');
    await ctx.engine.listRegistrations!();
    expect(http.calls[0].headers.authorization).toBe('Bearer rk_live_fixture');
  });

  it('loads Avalara with its credentials and the company settings', async () => {
    await seedEntity('ent_avalara', {
      salesTaxEngine: 'avalara',
      salesTaxEngineConfig: { companyCode: 'ACME', environment: 'sandbox' },
      salesTaxCredentialsEncrypted: 'blob-2',
    });
    const http = fakeFetch([{ json: { value: [{ id: 5 }] } }, { json: { value: [] } }]);
    const ctx = await loadSalesTaxContext(db, 'ent_avalara', {
      decrypt: async () => JSON.stringify({ accountId: '123', licenseKey: 'key' }),
      fetch: http.fetch,
    });
    expect(ctx.engineId).toBe('avalara');
    await ctx.engine.listRegistrations!();
    expect(http.calls[0].url).toContain('https://sandbox-rest.avatax.com/api/v2/companies?');
    expect(decodeURIComponent(http.calls[0].url)).toContain("companyCode eq 'ACME'");
  });

  it('a provider engine without credentials is not configured', async () => {
    await seedEntity('ent_nocreds', { salesTaxEngine: 'stripe_tax' });
    await expect(loadSalesTaxContext(db, 'ent_nocreds', { decrypt: async () => '{}' })).rejects.toMatchObject({
      name: 'SalesTaxEngineError',
      code: 'not_configured',
    });
  });

  it('unreadable or incomplete credentials are not configured, without leaking them', async () => {
    await seedEntity('ent_badblob', { salesTaxEngine: 'stripe_tax', salesTaxCredentialsEncrypted: 'blob' });
    const garbled = await loadSalesTaxContext(db, 'ent_badblob', { decrypt: async () => 'not json {' }).catch((e: Error) => e);
    expect(garbled).toBeInstanceOf(SalesTaxEngineError);
    expect((garbled as SalesTaxEngineError).code).toBe('not_configured');

    const failing = await loadSalesTaxContext(db, 'ent_badblob', {
      decrypt: async () => {
        throw new Error('bad key sk_live_secret');
      },
    }).catch((e: Error) => e);
    expect((failing as SalesTaxEngineError).code).toBe('not_configured');
    expect((failing as Error).message).not.toContain('sk_live_secret');

    await seedEntity('ent_partial', {
      salesTaxEngine: 'avalara',
      salesTaxEngineConfig: { companyCode: 'ACME' },
      salesTaxCredentialsEncrypted: 'blob',
    });
    await expect(
      loadSalesTaxContext(db, 'ent_partial', { decrypt: async () => JSON.stringify({ accountId: '123' }) }),
    ).rejects.toMatchObject({ code: 'not_configured' });

    await seedEntity('ent_nocompany', {
      salesTaxEngine: 'avalara',
      salesTaxEngineConfig: {},
      salesTaxCredentialsEncrypted: 'blob',
    });
    await expect(
      loadSalesTaxContext(db, 'ent_nocompany', { decrypt: async () => JSON.stringify({ accountId: '1', licenseKey: 'k' }) }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('an unknown engine or entity is not configured', async () => {
    await seedEntity('ent_unknown', { salesTaxEngine: 'taxjar' });
    await expect(loadSalesTaxContext(db, 'ent_unknown', { decrypt: async () => '' })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(loadSalesTaxContext(db, 'ent_missing', { decrypt: async () => '' })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('loads a customer certificates with the tax date of their last use', async () => {
    await seedEntity('ent_certs');
    await db.insert(schema.exemptionCertificates).values([
      { id: 'cert_a', entityId: 'ent_certs', partyId: 'party_1', states: ['OH', 'TX'], reason: 'resale', certificateNumber: 'A-1', form: 'sst_f0003', issuedOn: '2025-01-10', status: 'valid' },
      { id: 'cert_b', entityId: 'ent_certs', partyId: 'party_1', states: ['WA'], reason: 'nonprofit', blanket: false, invoiceId: 'inv_9', status: 'pending' },
      { id: 'cert_c', entityId: 'ent_certs', partyId: 'party_2', states: ['FL'], reason: 'resale' },
      { id: 'cert_d', entityId: 'ent_certs', partyId: 'party_1', states: ['FL'], reason: 'resale', deletedAt: new Date() },
    ]);
    for (const [id, taxDate] of [['tl_1', '2025-06-01'], ['tl_2', '2025-11-20'], ['tl_3', '2025-09-09']] as const) {
      await db.insert(schema.taxLines).values({
        id,
        entityId: 'ent_certs',
        sourceType: 'invoice',
        sourceId: id,
        journalEntryId: `je_${id}`,
        taxDate,
        direction: 'sales',
        rate: '0',
        taxableAmount: '0',
        taxAmount: '0',
        currency: 'USD',
        baseTaxableAmount: '0',
        baseTaxAmount: '0',
        certificateId: 'cert_a',
      });
    }

    const certs = await loadCustomerCertificates(db, 'ent_certs', 'party_1');
    expect(certs.map((c) => c.id).sort()).toEqual(['cert_a', 'cert_b']);
    const a = certs.find((c) => c.id === 'cert_a');
    expect(a).toMatchObject({
      states: ['OH', 'TX'],
      reason: 'resale',
      certificateNumber: 'A-1',
      form: 'sst_f0003',
      issuedOn: '2025-01-10',
      blanket: true,
      status: 'valid',
      lastUsedOn: '2025-11-20',
    });
    const b = certs.find((c) => c.id === 'cert_b');
    expect(b).toMatchObject({ blanket: false, invoiceId: 'inv_9', status: 'pending', lastUsedOn: null });

    expect(await loadCustomerCertificates(db, 'ent_certs', 'party_none')).toEqual([]);
    expect(await loadCustomerCertificates(db, 'ent_other', 'party_1')).toEqual([]);
  });

  it('the loaded SST blanket certificate expires 12 months after its last use', async () => {
    const { resolveExemptionCertificate } = await import('./exemptions');
    const certs = await loadCustomerCertificates(db, 'ent_certs', 'party_1');
    const ok = resolveExemptionCertificate(certs, { stateCode: 'OH', date: '2026-11-20' });
    expect(ok.valid).toBe(true);
    const late = resolveExemptionCertificate(certs, { stateCode: 'OH', date: '2026-11-21' });
    expect(late).toMatchObject({ valid: false, reason: 'certificate_expired' });
  });

});
