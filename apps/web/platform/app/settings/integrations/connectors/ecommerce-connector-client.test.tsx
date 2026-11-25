import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { en } from '@weldsuite/i18n/locales/en';
import type { ConnectorCatalogEntry, ConnectorConnection } from '@/hooks/queries/use-connector-queries';

vi.mock('@/lib/i18n/provider', async () => {
  const locale = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: locale.en, language: 'en', format: interpolate }) };
});

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  catalog: { data: undefined as { data: unknown[] } | undefined, isLoading: false },
  disconnect: { mutate: vi.fn(), isPending: false },
  permissions: { canAny: vi.fn(() => true), isLoading: false },
  consume: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => mocks.permissions }));
vi.mock('@/components/settings', () => ({
  IntegrationDetailLayout: (props: { name: string; connected: boolean; category: string; children: ReactNode }) => (
    <section aria-label={props.name} data-connected={props.connected} data-category={props.category}>
      {props.children}
    </section>
  ),
}));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useConnectorCatalog: () => mocks.catalog,
  useDisconnectConnector: () => mocks.disconnect,
}));
vi.mock('./connect-dialog', () => ({
  consumeWooCommerceAuthReturn: (...args: unknown[]) => mocks.consume(...args),
  ConnectDialog: ({ connector, onOpenChange }: { connector: ConnectorCatalogEntry | null; onOpenChange: (open: boolean) => void }) =>
    connector ? (
      <div role="dialog" aria-label="connect">
        {connector.provider}
        <button type="button" onClick={() => onOpenChange(false)}>
          close-connect
        </button>
      </div>
    ) : null,
  ConnectionDetails: ({
    connectionId,
    onOpenChange,
    onDisconnect,
  }: {
    connectionId: string | null;
    onOpenChange: (open: boolean) => void;
    onDisconnect: (connection: ConnectorConnection) => void;
  }) =>
    connectionId ? (
      <div aria-label="details">
        {connectionId}
        <button type="button" onClick={() => onOpenChange(false)}>
          close-details
        </button>
        <button type="button" onClick={() => onDisconnect({ id: connectionId, label: 'Store label', displayName: null } as ConnectorConnection)}>
          ask-disconnect
        </button>
      </div>
    ) : null,
}));

import { EcommerceConnectorSettingsPage, isConnectorProvider, CONNECTOR_PROVIDERS } from './ecommerce-connector-client';

const tc = en.settings.integrations.connectors;

function connection(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: 'cc_1',
    provider: 'woocommerce',
    label: 'WooCommerce',
    displayName: 'My shop',
    status: 'active',
    externalAccountId: 'shop.example',
    ...overrides,
  } as ConnectorConnection;
}

function entry(provider: string, connections: ConnectorConnection[] = []): ConnectorCatalogEntry {
  return {
    provider,
    label: provider,
    description: '',
    category: 'x',
    icon: 'x',
    auth: { kind: 'api_key', fields: [] },
    syncs: [],
    connections,
    connectionCount: connections.length,
  };
}

function renderPage(provider: (typeof CONNECTOR_PROVIDERS)[number]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<EcommerceConnectorSettingsPage provider={provider} />, { wrapper });
  return { invalidate };
}

beforeEach(() => {
  mocks.catalog.data = { data: [] };
  mocks.catalog.isLoading = false;
  mocks.permissions.canAny.mockReturnValue(true);
  mocks.permissions.isLoading = false;
  mocks.disconnect.isPending = false;
});

afterEach(() => vi.clearAllMocks());

describe('connector providers', () => {
  it('recognises the providers that have a Settings page, and nothing else', () => {
    expect(isConnectorProvider('stripe')).toBe(true);
    expect(isConnectorProvider('odoo')).toBe(true);
    expect(isConnectorProvider('slack')).toBe(false);
  });
});

describe('EcommerceConnectorSettingsPage', () => {
  it('shows a loader while the catalog loads', () => {
    mocks.catalog.isLoading = true;
    renderPage('woocommerce');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByText(tc.title)).not.toBeInTheDocument();
  });

  it('says the integration is not offered when the catalog lacks the provider', () => {
    mocks.catalog.data = { data: [entry('shopify')] };
    renderPage('odoo');
    expect(screen.getByText(en.settings.integrations.list.noneOfferedTitle)).toBeInTheDocument();
  });

  it('lists the connections of a provider with their status and account', () => {
    mocks.catalog.data = {
      data: [entry('woocommerce', [connection(), connection({ id: 'cc_2', displayName: null, externalAccountId: null, label: 'Second shop', status: 'sync_error' })])],
    };
    renderPage('woocommerce');
    expect(screen.getByRole('region', { name: en.settings.integrations.woocommerce.title })).toHaveAttribute('data-connected', 'true');
    expect(screen.getByText('My shop')).toBeInTheDocument();
    expect(screen.getByText('shop.example')).toBeInTheDocument();
    expect(screen.getByText('Second shop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tc.addStore })).toBeInTheDocument();
  });

  it('shows the empty state of a provider without connections and offers to connect', () => {
    mocks.catalog.data = { data: [entry('stripe')] };
    renderPage('stripe');
    expect(screen.getByRole('region', { name: en.settings.integrations.stripe.title })).toHaveAttribute('data-connected', 'false');
    expect(screen.getByText(tc.noStores)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(screen.getByRole('dialog', { name: 'connect' })).toHaveTextContent('stripe');
    fireEvent.click(screen.getByText('close-connect'));
    expect(screen.queryByRole('dialog', { name: 'connect' })).not.toBeInTheDocument();
  });

  it.each(['woocommerce', 'shopify', 'moneybird', 'stripe', 'picqer', 'odoo'] as const)(
    'renders the %s page with its category',
    (provider) => {
      mocks.catalog.data = { data: [entry(provider)] };
      renderPage(provider);
      expect(screen.getByRole('region', { name: en.settings.integrations[provider].title })).toBeInTheDocument();
    },
  );

  it('hides the connect button from someone who may not connect', () => {
    mocks.permissions.canAny.mockReturnValue(false);
    mocks.catalog.data = { data: [entry('odoo')] };
    renderPage('odoo');
    expect(screen.queryByRole('button', { name: tc.connect })).not.toBeInTheDocument();
  });

  it('opens the details of a connection and closes them again', () => {
    mocks.catalog.data = { data: [entry('woocommerce', [connection()])] };
    renderPage('woocommerce');
    fireEvent.click(screen.getByRole('button', { name: tc.viewDetails }));
    expect(screen.getByLabelText('details')).toHaveTextContent('cc_1');
    fireEvent.click(screen.getByText('close-details'));
    expect(screen.queryByLabelText('details')).not.toBeInTheDocument();
  });

  it('refreshes the catalog after returning from the store', () => {
    mocks.catalog.data = { data: [entry('woocommerce')] };
    const { invalidate } = renderPage('woocommerce');
    const onSettled = mocks.consume.mock.calls[0][1] as () => void;
    onSettled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connectors'] });
  });
});

describe('disconnecting a connection', () => {
  function openConfirm() {
    mocks.catalog.data = { data: [entry('woocommerce', [connection()])] };
    renderPage('woocommerce');
    fireEvent.click(screen.getByRole('button', { name: tc.viewDetails }));
    fireEvent.click(screen.getByText('ask-disconnect'));
  }

  it('asks for confirmation naming the connection', () => {
    openConfirm();
    expect(screen.getByText('Disconnect Store label?')).toBeInTheDocument();
  });

  it('disconnects after confirmation and closes the details', () => {
    openConfirm();
    fireEvent.click(screen.getByRole('button', { name: tc.disconnect }));
    expect(mocks.disconnect.mutate).toHaveBeenCalledWith('cc_1', expect.any(Object));
    const options = mocks.disconnect.mutate.mock.calls[0][1] as { onSuccess: () => void; onError: () => void };
    options.onSuccess();
    expect(mocks.toast.success).toHaveBeenCalledWith(tc.disconnected);
    options.onError();
    expect(mocks.toast.error).toHaveBeenCalledWith(tc.disconnectFailed);
  });

  it('keeps the connection when the confirmation is cancelled', () => {
    openConfirm();
    fireEvent.click(screen.getByRole('button', { name: en.common.actions.cancel }));
    expect(mocks.disconnect.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText('Disconnect Store label?')).not.toBeInTheDocument();
  });
});
