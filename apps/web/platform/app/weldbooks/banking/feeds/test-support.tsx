/**
 * Shared fixtures and render helpers of the bank feed tests. Not a test file
 * itself: each test file mocks the transport (`weldbooksApi`), permissions,
 * the WeldBooks formatter and toasts, then renders through here.
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type {
  BankFeedAccount,
  BankFeedCapabilities,
  BankFeedConnection,
  BankFeedProviderOption,
} from '@/lib/api/domains/weldbooks-bank-feeds';

export const PLAID_CAPABILITIES: BankFeedCapabilities = {
  regions: ['US'],
  changeCursor: true,
  webhooks: true,
  pendingTransactions: true,
  maxHistoryDays: 730,
  onDemandRefresh: true,
  accountTypes: ['depository', 'credit'],
};

export const STRIPE_CAPABILITIES: BankFeedCapabilities = {
  regions: ['US'],
  changeCursor: true,
  webhooks: true,
  pendingTransactions: true,
  maxHistoryDays: 180,
  onDemandRefresh: true,
  accountTypes: ['depository', 'credit'],
};

export const PONTO_CAPABILITIES: BankFeedCapabilities = {
  regions: ['NL', 'BE'],
  changeCursor: false,
  webhooks: false,
  pendingTransactions: false,
  maxHistoryDays: 90,
  onDemandRefresh: false,
  consentTtlDays: 180,
  accountTypes: ['depository'],
};

export function makeProvider(
  id: string,
  kind: BankFeedProviderOption['kind'],
  overrides: Partial<BankFeedProviderOption> = {},
): BankFeedProviderOption {
  return {
    id,
    kind,
    requiresInstitution: false,
    capabilities: id === 'stripe_fc' ? STRIPE_CAPABILITIES : id === 'ponto' ? PONTO_CAPABILITIES : PLAID_CAPABILITIES,
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<BankFeedAccount> = {}): BankFeedAccount {
  return {
    feedAccountId: 'fa_1',
    name: 'Business Checking',
    mask: '0001',
    type: 'depository',
    subtype: 'checking',
    currency: 'USD',
    status: 'active',
    bankAccountId: null,
    bankAccountName: null,
    syncFrom: null,
    ...overrides,
  };
}

export function makeConnection(overrides: Partial<BankFeedConnection> = {}): BankFeedConnection {
  return {
    id: 'bkc_1',
    entityId: 'ent_1',
    provider: 'plaid',
    institutionId: 'ins_1',
    institutionName: 'First Platypus Bank',
    status: 'active',
    lastSyncedAt: null,
    lastError: null,
    consentExpiresAt: null,
    historyDays: 730,
    createdAt: '2026-10-01T09:00:00.000Z',
    capabilities: PLAID_CAPABILITIES,
    accounts: [makeAccount()],
    warnings: [],
    ...overrides,
  };
}

/** A WeldBooks bank account as `GET /bank-accounts` returns it. */
export function makeBankAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ba_1',
    name: 'Operating',
    iban: null,
    bankName: 'First Platypus Bank',
    currentBalance: '0',
    currency: 'USD',
    isActive: true,
    lastImportDate: null,
    feedConnectionId: null,
    feedStatus: null,
    ...overrides,
  };
}

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
