/**
 * Fixtures for the sales tax tests. The rates are invented: real rates go
 * stale, and a test must never depend on them.
 */

import type { PostalAddress } from '@weldsuite/db/schema';
import type {
  ExemptionCertificateRef,
  SalesTaxResult,
  ManualEngineData,
  ManualJurisdiction,
  ManualTaxabilityRule,
  ManualZone,
  SalesTaxRegistration,
  SalesTaxRequest,
  SalesTaxRequestLine,
} from './types';

export const ENTITY_ID = 'ent_test';

function jur(
  id: string,
  agencyId: string,
  stateCode: string,
  level: ManualJurisdiction['level'],
  name: string,
  rate: number,
  extra: Partial<ManualJurisdiction> = {},
): ManualJurisdiction {
  return {
    id,
    agencyId,
    stateCode,
    level,
    name,
    code: extra.code ?? id,
    reportingCode: extra.reportingCode ?? null,
    rates: extra.rates ?? [{ rate, effectiveFrom: '2020-01-01', effectiveTo: null }],
  };
}

function zone(
  id: string,
  agencyId: string,
  stateCode: string,
  name: string,
  jurisdictionIds: string[],
  extra: Partial<ManualZone> = {},
): ManualZone {
  return {
    id,
    agencyId,
    stateCode,
    name,
    jurisdictionIds,
    postalCodes: extra.postalCodes ?? [],
    isOrigin: extra.isOrigin ?? false,
    priority: extra.priority ?? 100,
  };
}

export function rule(
  agencyId: string,
  taxCode: string,
  extra: Partial<ManualTaxabilityRule> = {},
): ManualTaxabilityRule {
  return {
    agencyId,
    taxCode,
    taxable: true,
    taxablePercent: 100,
    appliesToUse: 'any',
    rateOverride: null,
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    ...extra,
  };
}

/** Texas (origin), Washington (destination), California (modified origin), Florida, Maryland, Colorado with a home-rule city. */
export function buildManualData(extraRules: ManualTaxabilityRule[] = []): ManualEngineData {
  const jurisdictions: ManualJurisdiction[] = [
    // Texas: state 5.00, Fixtown city 1.50 + transit district 0.75 = 7.25; Otherville city 1.00 = 6.00.
    jur('tx_state', 'ag_tx', 'TX', 'state', 'Texas', 5, { reportingCode: 'TX-0' }),
    jur('tx_fixtown', 'ag_tx', 'TX', 'city', 'Fixtown', 1.5, { reportingCode: 'TX-1' }),
    jur('tx_transit', 'ag_tx', 'TX', 'district', 'Fixtown Transit', 0.75, { reportingCode: 'TX-2' }),
    jur('tx_other', 'ag_tx', 'TX', 'city', 'Otherville', 1, { reportingCode: 'TX-3' }),
    // Washington: state 6.00; Alpha 2.00 + Transit 1.00 = 9.00; Beta 3.50 = 9.50.
    jur('wa_state', 'ag_wa', 'WA', 'state', 'Washington', 6, { reportingCode: 'WA-0000' }),
    jur('wa_alpha', 'ag_wa', 'WA', 'city', 'Alpha', 2, { reportingCode: 'WA-1001' }),
    jur('wa_transit', 'ag_wa', 'WA', 'district', 'Regional Transit', 1, { reportingCode: 'WA-1002' }),
    jur('wa_beta', 'ag_wa', 'WA', 'city', 'Beta', 3.5, { reportingCode: 'WA-2001' }),
    // California: state 6.00, county 1.00, city 0.25 at origin; district 1.50 at destination.
    jur('ca_state', 'ag_ca', 'CA', 'state', 'California', 6),
    jur('ca_county', 'ag_ca', 'CA', 'county', 'Origin County', 1),
    jur('ca_city', 'ag_ca', 'CA', 'city', 'Origin City', 0.25),
    jur('ca_district', 'ag_ca', 'CA', 'district', 'Buyer District', 1.5),
    jur('ca_district_none', 'ag_ca', 'CA', 'district', 'Other District', 0.5),
    // Florida: state 6.00 + county 1.00.
    jur('fl_state', 'ag_fl', 'FL', 'state', 'Florida', 6),
    jur('fl_county', 'ag_fl', 'FL', 'county', 'Fixture County', 1),
    // Maryland: one state rate 6.00.
    jur('md_state', 'ag_md', 'MD', 'state', 'Maryland', 6),
    // Colorado: state 3.00 plus a self-administered home-rule city 4.00.
    jur('co_state', 'ag_co', 'CO', 'state', 'Colorado', 3),
    jur('co_city', 'ag_co_city', 'CO', 'city', 'Home Rule City', 4),
    // Rate change: Dated 5.00 until 2026-06-30, 5.50 from 2026-07-01.
    jur('ky_state', 'ag_ky', 'KY', 'state', 'Kentucky', 0, {
      rates: [
        { rate: 5, effectiveFrom: '2020-01-01', effectiveTo: '2026-06-30' },
        { rate: 5.5, effectiveFrom: '2026-07-01', effectiveTo: null },
      ],
    }),
  ];

  const zones: ManualZone[] = [
    zone('z_tx_fixtown', 'ag_tx', 'TX', 'Fixtown', ['tx_state', 'tx_fixtown', 'tx_transit'], {
      isOrigin: true,
      postalCodes: ['78701'],
    }),
    zone('z_tx_other', 'ag_tx', 'TX', 'Otherville', ['tx_state', 'tx_other'], { postalCodes: ['78801'] }),
    zone('z_wa_alpha', 'ag_wa', 'WA', 'Alpha', ['wa_state', 'wa_alpha', 'wa_transit'], {
      postalCodes: ['98001', '98002'],
    }),
    zone('z_wa_beta', 'ag_wa', 'WA', 'Beta', ['wa_state', 'wa_beta'], {
      postalCodes: [{ from: '98100', to: '98199' }],
    }),
    zone('z_ca_origin', 'ag_ca', 'CA', 'Origin', ['ca_state', 'ca_county', 'ca_city'], {
      isOrigin: true,
      postalCodes: ['94001'],
    }),
    zone('z_ca_buyer', 'ag_ca', 'CA', 'Buyer', ['ca_state', 'ca_county', 'ca_city', 'ca_district'], {
      postalCodes: ['95001'],
    }),
    zone('z_fl', 'ag_fl', 'FL', 'All Florida', ['fl_state', 'fl_county'], { postalCodes: [{ from: '32000', to: '34999' }] }),
    zone('z_md', 'ag_md', 'MD', 'Maryland', ['md_state'], { postalCodes: [{ from: '20600', to: '21999' }] }),
    zone('z_co', 'ag_co', 'CO', 'Colorado', ['co_state'], { postalCodes: [{ from: '80000', to: '81999' }] }),
    zone('z_co_city', 'ag_co_city', 'CO', 'Home rule', ['co_city'], { postalCodes: ['80202'] }),
    zone('z_ky', 'ag_ky', 'KY', 'Kentucky', ['ky_state'], { postalCodes: [{ from: '40000', to: '42999' }] }),
  ];

  return { jurisdictions, zones, rules: extraRules };
}

export function reg(
  agencyId: string,
  stateCode: string,
  extra: Partial<SalesTaxRegistration> = {},
): SalesTaxRegistration {
  return {
    agencyId,
    stateCode,
    level: 'state',
    status: 'registered',
    registeredFrom: '2020-01-01',
    registeredUntil: null,
    ...extra,
  };
}

export const REGISTRATIONS: SalesTaxRegistration[] = [
  reg('ag_tx', 'TX'),
  reg('ag_wa', 'WA'),
  reg('ag_ca', 'CA'),
  reg('ag_fl', 'FL'),
  reg('ag_md', 'MD'),
  reg('ag_co', 'CO'),
  reg('ag_co_city', 'CO', { level: 'local', localJurisdictionCode: 'co_city' }),
  reg('ag_ky', 'KY'),
];

export const TX_SELLER: PostalAddress = { line1: '1 Main', city: 'Fixtown', state: 'TX', postalCode: '78701', country: 'US' };
export const CA_SELLER: PostalAddress = { line1: '2 Bay', city: 'Origin City', state: 'CA', postalCode: '94001', country: 'US' };
export const WA_SELLER: PostalAddress = { line1: '3 Pike', city: 'Alpha', state: 'WA', postalCode: '98001', country: 'US' };

export function addr(state: string, postalCode: string, city = 'Somewhere'): PostalAddress {
  return { line1: '10 Test St', city, state, postalCode, country: 'US' };
}

export function line(
  lineId: string,
  amount: number,
  extra: Partial<SalesTaxRequestLine> = {},
): SalesTaxRequestLine {
  return { lineId, amount, quantity: 1, taxCode: 'general', use: 'business', ...extra };
}

export function request(extra: Partial<SalesTaxRequest> = {}): SalesTaxRequest {
  return {
    entityId: ENTITY_ID,
    documentType: 'invoice',
    documentId: 'inv_1',
    documentNumber: 'INV-0001',
    documentDate: '2026-03-15',
    currency: 'USD',
    shipFrom: TX_SELLER,
    shipTo: addr('TX', '78701'),
    customer: { partyId: 'party_1', certificates: [] },
    registrations: REGISTRATIONS,
    lines: [line('l1', 100)],
    ...extra,
  };
}

export function certificate(extra: Partial<ExemptionCertificateRef> = {}): ExemptionCertificateRef {
  return {
    id: 'cert_1',
    states: ['FL'],
    reason: 'resale',
    certificateNumber: '85-8012345678C-9',
    form: 'state_form',
    issuedOn: '2026-01-05',
    expiresOn: null,
    blanket: true,
    invoiceId: null,
    status: 'valid',
    ...extra,
  };
}

/** A calculation result with nothing in it, for commit calls that only need the reference. */
export function emptyResult(extra: Partial<SalesTaxResult> = {}): SalesTaxResult {
  return {
    engine: 'manual',
    calculatedAt: '2026-03-15T12:00:00.000Z',
    sourcing: 'none',
    lines: [],
    totalTax: 0,
    warnings: [],
    ...extra,
  };
}
