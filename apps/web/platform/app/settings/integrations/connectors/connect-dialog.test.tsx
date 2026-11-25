import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { en } from '@weldsuite/i18n/locales/en';
import type { ConnectorCatalogEntry } from '@/hooks/queries/use-connector-queries';

vi.mock('@/lib/i18n/provider', async () => {
  const locale = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: locale.en, language: 'en', format: interpolate }) };
});

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  connect: { mutate: vi.fn(), isPending: false },
  authorize: { mutate: vi.fn(), isPending: false },
  test: { mutate: vi.fn(), isPending: false },
  entities: [] as unknown,
  currentEntityId: null as string | null,
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_test' }));
vi.mock('@/hooks/use-current-accounting-entity', () => ({
  useCurrentAccountingEntity: () => ({ entityId: mocks.currentEntityId }),
}));
vi.mock('@/hooks/use-workspace-url', () => ({
  useWorkspaceUrl: () => (path: string) => `/w/acme${path}`,
}));
vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: { get: async () => mocks.entities },
}));
vi.mock('./connection-details', () => ({ ConnectionDetails: () => null }));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useConnectConnector: () => mocks.connect,
  useAuthorizeConnector: () => mocks.authorize,
  useTestConnector: () => mocks.test,
}));

import { ConnectDialog, consumeWooCommerceAuthReturn } from './connect-dialog';

const tc = en.settings.integrations.connectors;

interface MutateOptions<T = unknown> {
  onSuccess: (result: T) => void;
  onError: (error: unknown) => void;
}

function optionsOf<T = unknown>(spy: { mock: { calls: unknown[][] } }, call = 0): MutateOptions<T> {
  return spy.mock.calls[call][1] as MutateOptions<T>;
}

function entry(
  overrides: Partial<ConnectorCatalogEntry> & Pick<ConnectorCatalogEntry, 'provider'>,
): ConnectorCatalogEntry {
  return {
    label: overrides.provider,
    description: '',
    category: 'ecommerce',
    icon: 'x',
    auth: { kind: 'api_key', fields: [] },
    syncs: [],
    connections: [],
    connectionCount: 0,
    ...overrides,
  };
}

const picqer = entry({
  provider: 'picqer',
  label: 'Picqer',
  auth: {
    kind: 'api_key',
    fields: [
      { key: 'subdomain', label: 'Subdomain', type: 'text' },
      { key: 'apiKey', label: 'API key', type: 'secret' },
      { key: 'host', label: 'Host', type: 'url' },
    ],
  },
  syncs: [
    { settingKey: 'inventory', syncName: 'picqer-inventory', model: 'm', internalEntity: 'inventory' },
    { settingKey: 'inventory', syncName: 'picqer-inventory-2', model: 'm', internalEntity: 'inventory' },
    { settingKey: 'mystery', syncName: 'picqer-mystery', model: 'm', internalEntity: 'mystery' },
  ],
});
const woo = entry({
  provider: 'woocommerce',
  label: 'WooCommerce',
  auth: { kind: 'app_auth', fields: [{ key: 'storeUrl', label: 'Store URL', type: 'url' }] },
  syncs: [{ settingKey: 'orders', syncName: 'woo-orders', model: 'm', internalEntity: 'orders' }],
});
const moneybird = entry({
  provider: 'moneybird',
  label: 'Moneybird',
  category: 'accounting',
  auth: { kind: 'oauth2', fields: [] },
  syncs: [{ settingKey: 'contacts', syncName: 'mb-contacts', model: 'm', internalEntity: 'contacts' }],
});
const stripe = entry({
  provider: 'stripe',
  label: 'Stripe',
  category: 'accounting',
  auth: { kind: 'oauth2', fields: [] },
  syncs: [{ settingKey: 'invoices', syncName: 'stripe-invoices', model: 'm', internalEntity: 'invoices' }],
});

function renderDialog(connector: ConnectorCatalogEntry | null) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<ConnectDialog connector={connector} onOpenChange={onOpenChange} />, { wrapper });
  return { onOpenChange };
}

const assign = vi.fn();

function stubLocation(location: Partial<Location>) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, pathname: '/settings/integrations/woocommerce', search: '', hash: '', ...location },
  });
}

beforeEach(() => {
  mocks.entities = [];
  mocks.currentEntityId = null;
  mocks.connect.isPending = false;
  mocks.authorize.isPending = false;
  mocks.test.isPending = false;
  stubLocation({});
});

afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('ConnectDialog with credentials', () => {
  it('renders nothing for a missing connector', () => {
    renderDialog(null);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows one input per credential field and a toggle per distinct sync', () => {
    renderDialog(picqer);
    expect(screen.getByLabelText('Subdomain')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Host')).toHaveAttribute('type', 'url');
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.getByText(tc.settings.inventory)).toBeInTheDocument();
    // A sync without a label falls back to its setting key.
    expect(screen.getByText('mystery')).toBeInTheDocument();
  });

  it('tests the typed credentials and reports how the test went', () => {
    renderDialog(picqer);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: tc.testConnection }));
    expect(mocks.test.mutate).toHaveBeenCalledWith(
      { provider: 'picqer', credentials: { apiKey: 'secret' } },
      expect.any(Object),
    );
    const options = optionsOf(mocks.test.mutate);
    options.onSuccess(undefined);
    expect(mocks.toast.success).toHaveBeenCalledWith(tc.testSuccess);
    options.onError(new Error('nope'));
    expect(mocks.toast.error).toHaveBeenCalledWith('nope');
    options.onError('odd');
    expect(mocks.toast.error).toHaveBeenLastCalledWith(tc.testFailed);
  });

  it('connects with the typed credentials and the enabled syncs, then closes', () => {
    const { onOpenChange } = renderDialog(picqer);
    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'shop' } });
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.connect.mutate).toHaveBeenCalledWith(
      { provider: 'picqer', credentials: { subdomain: 'shop' }, enabledSyncs: ['inventory', 'mystery'] },
      expect.any(Object),
    );
    const options = optionsOf(mocks.connect.mutate);
    options.onSuccess(undefined);
    expect(mocks.toast.success).toHaveBeenCalledWith(tc.connected);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    options.onError(new Error('bad key'));
    expect(mocks.toast.error).toHaveBeenCalledWith('bad key');
    options.onError(null);
    expect(mocks.toast.error).toHaveBeenLastCalledWith(tc.connectFailed);
  });

  it('leaves a sync out of the connect when it is toggled off, and adds it back when toggled on', () => {
    renderDialog(picqer);
    const [inventory] = screen.getAllByRole('switch');
    fireEvent.click(inventory);
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.connect.mutate.mock.calls[0][0].enabledSyncs).toEqual(['mystery']);
    fireEvent.click(inventory);
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.connect.mutate.mock.calls[1][0].enabledSyncs).toEqual(['mystery', 'inventory']);
  });

  it('disables connect and test while connecting', () => {
    mocks.connect.isPending = true;
    renderDialog(picqer);
    expect(screen.getByRole('button', { name: tc.connect })).toBeDisabled();
    expect(screen.getByRole('button', { name: tc.testConnection })).toBeDisabled();
  });

  it('disables the test button while a test runs', () => {
    mocks.test.isPending = true;
    renderDialog(picqer);
    expect(screen.getByRole('button', { name: tc.testConnection })).toBeDisabled();
  });

  it('reports closing the dialog to the parent', () => {
    const { onOpenChange } = renderDialog(picqer);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ConnectDialog for WooCommerce', () => {
  it('has no test button and asks for the store URL first', () => {
    renderDialog(woo);
    expect(screen.queryByRole('button', { name: tc.testConnection })).not.toBeInTheDocument();
    expect(screen.getByText(tc.settings.connectDescriptionAppAuth)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.toast.error).toHaveBeenCalledWith(tc.enterStoreUrl);
    expect(mocks.authorize.mutate).not.toHaveBeenCalled();
  });

  it('sends the browser to the store and records the connector flow', () => {
    renderDialog(woo);
    fireEvent.change(screen.getByLabelText('Store URL'), { target: { value: ' https://shop.example ' } });
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.authorize.mutate).toHaveBeenCalledWith(
      {
        provider: 'woocommerce',
        storeUrl: 'https://shop.example',
        enabledSyncs: ['orders'],
        returnUrl: '/w/acme/settings/integrations/woocommerce',
      },
      expect.any(Object),
    );
    optionsOf<{ data: { authorizeUrl?: string } }>(mocks.authorize.mutate).onSuccess({
      data: { authorizeUrl: 'https://shop.example/wc-auth' },
    });
    expect(assign).toHaveBeenCalledWith('https://shop.example/wc-auth');
    expect(JSON.parse(sessionStorage.getItem('integrations_oauth_flow') ?? '{}')).toEqual({
      kind: 'connector',
      returnTo: '/settings/integrations/woocommerce',
    });
  });

  it('says so when the API returns no authorize URL, and when the request fails', () => {
    renderDialog(woo);
    fireEvent.change(screen.getByLabelText('Store URL'), { target: { value: 'https://shop.example' } });
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    const options = optionsOf<{ data: { authorizeUrl?: string } }>(mocks.authorize.mutate);
    options.onSuccess({ data: {} });
    expect(mocks.toast.error).toHaveBeenCalledWith(tc.connectFailed);
    expect(assign).not.toHaveBeenCalled();
    options.onError(new Error('offline'));
    expect(mocks.toast.error).toHaveBeenCalledWith('offline');
    options.onError(undefined);
    expect(mocks.toast.error).toHaveBeenLastCalledWith(tc.connectFailed);
  });
});

describe('ConnectDialog for Moneybird', () => {
  it('blocks connecting and says so when there is no WeldBooks entity', async () => {
    renderDialog(moneybird);
    expect(await screen.findByText(tc.settings.entityMissing)).toBeInTheDocument();
    expect(screen.getByText(tc.settings.connectDescriptionOAuth)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tc.connect })).toBeDisabled();
  });

  it('offers the active entities and authorizes against the default one', async () => {
    mocks.entities = {
      data: [
        { id: 'ent_old', name: 'Old BV', isActive: false },
        { id: 'ent_a', name: 'Alpha BV', isDefault: false },
        { id: 'ent_b', name: 'Beta BV', isDefault: true },
      ],
    };
    renderDialog(moneybird);
    await waitFor(() => expect(screen.getByRole('button', { name: tc.connect })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.authorize.mutate).toHaveBeenCalledWith(
      {
        provider: 'moneybird',
        enabledSyncs: ['contacts'],
        entityId: 'ent_b',
        returnUrl: '/w/acme/settings/integrations/woocommerce',
      },
      expect.any(Object),
    );
  });

  it('prefers the entity the workspace is currently on', async () => {
    mocks.entities = [
      { id: 'ent_a', name: 'Alpha BV', isDefault: true },
      { id: 'ent_b', name: 'Beta BV' },
    ];
    mocks.currentEntityId = 'ent_b';
    renderDialog(moneybird);
    await waitFor(() => expect(screen.getByRole('button', { name: tc.connect })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.authorize.mutate.mock.calls[0][0].entityId).toBe('ent_b');
  });

  it('falls back to the first entity when none is the default', async () => {
    mocks.entities = [{ id: 'ent_a', name: 'Alpha BV' }];
    renderDialog(moneybird);
    await waitFor(() => expect(screen.getByRole('button', { name: tc.connect })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.authorize.mutate.mock.calls[0][0].entityId).toBe('ent_a');
  });
});

describe('ConnectDialog for Stripe', () => {
  beforeEach(() => {
    mocks.entities = [{ id: 'ent_a', name: 'Alpha BV', isDefault: true }];
  });

  it('asks for an import start date and connects with Stripe', async () => {
    renderDialog(stripe);
    const date = screen.getByLabelText(tc.settings.importStartDateLabel);
    expect(date).toHaveValue(`${new Date().getFullYear()}-01-01`);
    fireEvent.change(date, { target: { value: '2025-03-01' } });
    const button = screen.getByRole('button', { name: tc.connectWithStripe });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(mocks.authorize.mutate.mock.calls[0][0]).toEqual({
      provider: 'stripe',
      enabledSyncs: ['invoices'],
      entityId: 'ent_a',
      importStartDate: '2025-03-01',
      returnUrl: '/w/acme/settings/integrations/woocommerce',
    });
  });

  it('will not connect without a start date', () => {
    renderDialog(stripe);
    fireEvent.change(screen.getByLabelText(tc.settings.importStartDateLabel), { target: { value: '' } });
    expect(screen.getByRole('button', { name: tc.connectWithStripe })).toBeDisabled();
  });

  it('connects with an API key from the collapsible section', async () => {
    const { onOpenChange } = renderDialog(stripe);
    fireEvent.click(screen.getByRole('button', { name: tc.settings.stripeApiKeyToggle }));
    const connectKey = await screen.findByRole('button', { name: tc.settings.stripeApiKeyConnect });
    expect(connectKey).toBeDisabled();
    fireEvent.change(screen.getByLabelText(tc.settings.stripeApiKeyLabel), { target: { value: ' rk_test_1 ' } });
    await waitFor(() => expect(connectKey).toBeEnabled());
    fireEvent.click(connectKey);
    expect(mocks.connect.mutate.mock.calls[0][0]).toEqual({
      provider: 'stripe',
      credentials: { apiKey: 'rk_test_1' },
      enabledSyncs: ['invoices'],
      entityId: 'ent_a',
      settings: { importStartDate: `${new Date().getFullYear()}-01-01` },
    });
    const options = optionsOf(mocks.connect.mutate);
    options.onSuccess(undefined);
    expect(mocks.toast.success).toHaveBeenCalledWith(tc.connected);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    options.onError(new Error('rejected'));
    expect(mocks.toast.error).toHaveBeenCalledWith('rejected');
    options.onError(0);
    expect(mocks.toast.error).toHaveBeenLastCalledWith(tc.connectFailed);
  });

  it('keeps the API key button off while the key is blank', async () => {
    renderDialog(stripe);
    fireEvent.click(screen.getByRole('button', { name: tc.settings.stripeApiKeyToggle }));
    const connectKey = await screen.findByRole('button', { name: tc.settings.stripeApiKeyConnect });
    fireEvent.change(screen.getByLabelText(tc.settings.stripeApiKeyLabel), { target: { value: '   ' } });
    expect(connectKey).toBeDisabled();
    expect(mocks.connect.mutate).not.toHaveBeenCalled();
  });

  it('forgets the typed key when the dialog closes', async () => {
    const { onOpenChange } = renderDialog(stripe);
    fireEvent.click(screen.getByRole('button', { name: tc.settings.stripeApiKeyToggle }));
    fireEvent.change(await screen.findByLabelText(tc.settings.stripeApiKeyLabel), { target: { value: 'rk' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('consumeWooCommerceAuthReturn', () => {
  const copy = { authReturned: 'returned', authDenied: 'denied' };

  it('toasts success, cleans the URL and settles on ?success=1', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    stubLocation({ search: '?success=1', hash: '#x' });
    const settled = vi.fn();
    consumeWooCommerceAuthReturn(copy, settled);
    expect(mocks.toast.success).toHaveBeenCalledWith('returned');
    expect(replaceState).toHaveBeenCalledWith({}, '', '/settings/integrations/woocommerce#x');
    expect(settled).toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it('toasts the denial on ?success=0, with no settle callback needed', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    stubLocation({ search: '?success=0' });
    consumeWooCommerceAuthReturn(copy);
    expect(mocks.toast.error).toHaveBeenCalledWith('denied');
    expect(replaceState).toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it('does nothing without the parameter', () => {
    stubLocation({ search: '' });
    const settled = vi.fn();
    consumeWooCommerceAuthReturn(copy, settled);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });
});
