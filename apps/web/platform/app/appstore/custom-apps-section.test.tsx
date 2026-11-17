import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { StoreUserApp } from '@/hooks/queries/use-user-apps-queries';

const store = vi.hoisted(() => ({ data: [] as StoreUserApp[] | undefined, isLoading: false }));
vi.mock('@/hooks/queries/use-user-apps-queries', () => ({
  useUserAppStore: () => store,
  useInstallUserApp: () => ({ mutateAsync: vi.fn() }),
  useUninstallUserApp: () => ({ mutateAsync: vi.fn() }),
  useConsentUserAppScopes: () => ({ mutateAsync: vi.fn() }),
  SubscriptionRequiredError: class extends Error {},
}));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => false, isOwner: false }) }));
vi.mock('@/components/weldapps/user-app-consent-dialog', () => ({ UserAppConsentDialog: () => null }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CustomAppsSection, OfficialHostedAppsSection } from './custom-apps-section';

function userApp(overrides: Partial<StoreUserApp>): StoreUserApp {
  return {
    id: 'uapp_1',
    code: 'timesheets',
    name: 'Timesheets',
    description: 'Log hours against projects',
    category: 'Productivity',
    visibility: 'public',
    reviewStatus: 'approved',
    requestedScopes: [],
    pricingType: 'free',
    publisherType: 'community',
    installCount: 0,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const official = userApp({ id: 'uapp_2', code: 'standup', name: 'Standup', description: 'Daily team check-ins', publisherType: 'weldsuite' });
const community = userApp({});

function wrap(ui: React.ReactElement) {
  return render(<I18nProvider initialLanguage="en">{ui}</I18nProvider>);
}

afterEach(() => {
  cleanup();
  store.data = [];
  store.isLoading = false;
});

describe('OfficialHostedAppsSection', () => {
  it('lists only the official apps', () => {
    store.data = [official, community];
    wrap(<OfficialHostedAppsSection />);

    expect(screen.getByText('Standup')).toBeInTheDocument();
    expect(screen.queryByText('Timesheets')).not.toBeInTheDocument();
  });

  it('shows only the official apps that match the search', () => {
    store.data = [official, userApp({ id: 'uapp_3', code: 'okr', name: 'Goals', publisherType: 'weldsuite' })];
    wrap(<OfficialHostedAppsSection query="check-ins" />);

    expect(screen.getByText('Standup')).toBeInTheDocument();
    expect(screen.queryByText('Goals')).not.toBeInTheDocument();
  });

  it('is left out when no official app matches', () => {
    store.data = [official];
    const { container } = wrap(<OfficialHostedAppsSection query="invoices" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is left out when the store has no list yet', () => {
    store.data = undefined;
    const { container } = wrap(<OfficialHostedAppsSection />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CustomAppsSection', () => {
  it('lists only the community apps', () => {
    store.data = [official, community];
    wrap(<CustomAppsSection />);

    expect(screen.getByText('Timesheets')).toBeInTheDocument();
    expect(screen.queryByText('Standup')).not.toBeInTheDocument();
  });

  it('shows the matches while searching or filtering', () => {
    store.data = [community, userApp({ id: 'uapp_4', code: 'ledger', name: 'Ledger', category: 'Accounting' })];
    wrap(<CustomAppsSection filters={[{ field: 'category', operator: 'is', value: 'Finance' }]} />);

    expect(screen.getByText('Ledger')).toBeInTheDocument();
    expect(screen.queryByText('Timesheets')).not.toBeInTheDocument();
  });

  it('is left out when a search matches none of them', () => {
    store.data = [community];
    const { container } = wrap(<CustomAppsSection query="invoices" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('still shows its empty text when nothing narrows the store', () => {
    store.data = [];
    const { container } = wrap(<CustomAppsSection filters={[{ field: 'category', operator: 'is', value: '' }]} />);
    expect(container).not.toBeEmptyDOMElement();
  });

  it('stays while the list is loading', () => {
    store.data = undefined;
    store.isLoading = true;
    const { container } = wrap(<CustomAppsSection query="time" />);
    expect(container).not.toBeEmptyDOMElement();
  });
});
