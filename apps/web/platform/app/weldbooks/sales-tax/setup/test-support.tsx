/**
 * Shared fixtures and render helpers of the sales tax setup tests. Not a test
 * file itself: each test file mocks the transport (`weldbooksApi`), the router,
 * permissions, the WeldBooks formatter and toasts, then renders through here.
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type {
  ExemptionCertificate,
  JurisdictionRate,
  SalesTaxAgency,
  SalesTaxJurisdiction,
  SalesTaxSettings,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';

export const TODAY = '2026-10-08';

/** Radix Select and Dialog use pointer-capture APIs jsdom does not implement. */
export function installPointerPolyfills(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
}

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export function renderWithProviders(ui: ReactElement, client: QueryClient = newQueryClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage="en">{ui}</I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

export function makeAgency(overrides: Partial<SalesTaxAgency> = {}): SalesTaxAgency {
  return {
    id: 'sta_1',
    entityId: 'ent_1',
    stateCode: 'TX',
    level: 'state',
    localJurisdictionCode: null,
    name: 'Texas Comptroller of Public Accounts',
    registrationNumber: '32-1234567',
    registeredFrom: '2026-01-01',
    registeredUntil: null,
    status: 'registered',
    filingFrequency: 'quarterly',
    firstPeriodStart: '2026-01-01',
    dueDay: 20,
    reportingBasis: 'accrual',
    sstMember: false,
    liabilityAccountId: 'acc_1',
    useTaxAccountId: 'acc_2',
    portalUrl: 'https://comptroller.texas.gov/taxes/sales',
    providerRegistrationRef: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    liabilityAccount: { id: 'acc_1', code: '2201', name: 'Sales Tax Payable – Texas', balance: '1250.00' },
    useTaxAccount: { id: 'acc_2', code: '2211', name: 'Use Tax Payable – Texas', balance: '0' },
    ...overrides,
  };
}

export function makeRate(overrides: Partial<JurisdictionRate> = {}): JurisdictionRate {
  return {
    id: 'stjr_1',
    jurisdictionId: 'stj_1',
    rate: '6.2500',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    ...overrides,
  };
}

export function makeJurisdiction(overrides: Partial<SalesTaxJurisdiction> = {}): SalesTaxJurisdiction {
  const rates = overrides.rates ?? [makeRate()];
  return {
    id: 'stj_1',
    agencyId: 'sta_1',
    stateCode: 'TX',
    level: 'state',
    code: null,
    name: 'Texas',
    reportingCode: null,
    isActive: true,
    currentRate: 6.25,
    rates,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<SalesTaxSettings> = {}): SalesTaxSettings {
  return {
    entityId: 'ent_1',
    engine: 'manual',
    config: { companyCode: null, environment: 'production' },
    hasCredentials: false,
    engineOptions: [
      { id: 'manual', credentialFields: [], configFields: [] },
      { id: 'stripe_tax', credentialFields: ['apiKey'], configFields: [] },
      { id: 'avalara', credentialFields: ['accountId', 'licenseKey'], configFields: ['companyCode', 'environment'] },
    ],
    agencies: [],
    registeredStates: [],
    ...overrides,
  };
}

export function makeCertificate(overrides: Partial<ExemptionCertificate> = {}): ExemptionCertificate {
  return {
    id: 'exc_1',
    entityId: 'ent_1',
    partyId: 'prt_1',
    states: ['TX', 'OK'],
    reason: 'resale',
    certificateNumber: '32-123',
    form: 'state_form',
    issuedOn: '2026-01-15',
    expiresOn: '2027-01-14',
    blanket: true,
    invoiceId: null,
    documentId: null,
    status: 'valid',
    storedStatus: 'valid',
    expiryByState: { TX: '2027-01-14', OK: '2027-01-14' },
    expiredStates: [],
    effectiveExpiresOn: '2027-01-14',
    daysUntilExpiry: 98,
    lastUsedOn: null,
    receivedOn: '2026-01-20',
    notes: null,
    createdAt: '2026-01-20T00:00:00.000Z',
    updatedAt: '2026-01-20T00:00:00.000Z',
    ...overrides,
  };
}
