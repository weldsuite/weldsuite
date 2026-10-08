/**
 * Fixtures and render helpers of the Sales Tax Center tests. Not a test file
 * itself: each test file mocks the router, the transport (`weldbooksApi`),
 * permissions, the WeldBooks formatter and toasts, then renders through here.
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type {
  AgencyOverview,
  NexusRow,
  ReturnLine,
  ReturnSummary,
  TaxReturnDetail,
} from '@/lib/api/domains/weldbooks-sales-tax-center';

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

export function makeSummary(overrides: Partial<ReturnSummary> = {}): ReturnSummary {
  return {
    reportingBasis: 'accrual',
    method: 'Accrual basis',
    grossSales: 12500,
    deductions: {
      resale: 2000,
      nonprofit: 0,
      government: 0,
      manufacturing: 0,
      agricultural: 0,
      other_exempt: 0,
      non_taxable: 500,
      exempt_freight: 0,
      marketplace: 0,
      returns: 250,
      bad_debts: 0,
    },
    totalDeductions: 2750,
    taxableSales: 9750,
    salesTaxDue: 804.38,
    useTaxDue: 20,
    totalTaxDue: 824.38,
    documentCount: 14,
    rowCount: 30,
    uncuredExempt: { sales: 0, tax: 0, lines: 0 },
    salesTaxPayable: 804.38,
    useTaxPayable: 20,
    uncuredTaxPayable: 0,
    vendorDiscount: { available: false, amount: 0, requiresTimelyFilingBy: null, late: false, note: null },
    warnings: [],
    calculatedAt: '2026-10-08T10:00:00.000Z',
    foreignCurrencyRows: 0,
    ...overrides,
  };
}

export const SALES_LINES: ReturnLine[] = [
  {
    kind: 'sales',
    jurisdictionCode: 'WA',
    jurisdictionName: 'Washington',
    level: 'state',
    reportingCode: '',
    rate: 6.5,
    taxableSales: 9750,
    tax: 633.75,
  },
  {
    kind: 'sales',
    jurisdictionCode: 'WA-SEATTLE',
    jurisdictionName: 'Seattle',
    level: 'city',
    reportingCode: '1700',
    rate: 3.55,
    taxableSales: 4800,
    tax: 170.63,
  },
  {
    kind: 'use',
    jurisdictionCode: 'WA',
    jurisdictionName: 'Washington',
    level: 'state',
    reportingCode: '',
    rate: 6.5,
    taxableSales: 307.69,
    tax: 20,
  },
];

export function makeReturn(overrides: Partial<TaxReturnDetail> = {}): TaxReturnDetail {
  return {
    id: 'txr_1',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    entityId: 'ent_1',
    jurisdictionCode: 'US',
    agencyId: 'sta_wa',
    stateCode: 'WA',
    periodStart: '2026-07-01',
    periodEnd: '2026-09-30',
    dueDate: '2026-10-25',
    status: 'calculated',
    reportingBasis: 'accrual',
    summary: makeSummary(),
    lines: SALES_LINES,
    adjustments: [],
    exceptions: null,
    totalDue: 824.38,
    filedAt: null,
    filedBy: null,
    confirmationNumber: null,
    paidAt: null,
    paymentAmount: null,
    paymentBankAccountId: null,
    paymentJournalEntryId: null,
    amendsReturnId: null,
    notes: null,
    agency: {
      id: 'sta_wa',
      name: 'Washington Department of Revenue',
      stateCode: 'WA',
      filingFrequency: 'quarterly',
      dueDay: 25,
      reportingBasis: 'accrual',
      registrationNumber: '603-123-456',
      portalUrl: 'https://dor.wa.gov',
    },
    amendments: [],
    overdue: false,
    ...overrides,
  };
}

export function makeAgencyOverview(overrides: Partial<AgencyOverview> = {}): AgencyOverview {
  return {
    agencyId: 'sta_wa',
    agencyName: 'Washington Department of Revenue',
    stateCode: 'WA',
    filingFrequency: 'quarterly',
    reportingBasis: 'accrual',
    nextPeriod: {
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      dueDate: '2026-10-25',
      daysUntilDue: 17,
      overdue: false,
      state: 'due',
      returnId: null,
      returnStatus: null,
      estimatedTaxDue: 824.38,
      estimatedSalesTax: 804.38,
      estimatedUseTax: 20,
    },
    overduePeriods: 0,
    lastFiled: null,
    ...overrides,
  };
}

export function makeNexusRow(overrides: Partial<NexusRow> = {}): NexusRow {
  return {
    stateCode: 'TX',
    stateName: 'Texas',
    applicable: true,
    ruleEffectiveFrom: '2019-10-01',
    salesTotal: 85000,
    transactionCount: 40,
    thresholdSales: 500000,
    thresholdTransactions: null,
    percentOfThreshold: 17,
    status: 'below',
    collectFromVerified: true,
    window: { from: '2025-10-09', to: '2026-10-08' },
    periods: [],
    unverified: [],
    registered: false,
    alert: 'ok',
    agencyId: null,
    agencyStatus: null,
    base: 'gross',
    comparison: 'gte',
    test: 'none',
    sourceUrl: 'https://example.test/texas',
    ruleNotes: null,
    ...overrides,
  };
}
