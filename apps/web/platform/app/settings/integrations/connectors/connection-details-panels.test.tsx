import { createContext, useContext, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { en } from '@weldsuite/i18n/locales/en';
import type {
  ConnectorConnection,
  ConnectorSyncDef,
  ConnectorSyncRun,
  ConnectorSyncedRecord,
} from '@/hooks/queries/use-connector-queries';

vi.mock('@/lib/i18n/provider', async () => {
  const locale = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: locale.en, language: 'en', format: interpolate }) };
});

interface SelectState {
  value?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
}

// Radix Select needs pointer APIs jsdom lacks: every option is a plain button instead.
const SelectContext = createContext<SelectState>({});
vi.mock('@weldsuite/ui/components/select', () => ({
  Select: ({ children, ...state }: SelectState & { children: ReactNode }) => (
    <SelectContext.Provider value={state}>
      <div data-testid="select" data-value={state.value} data-disabled={state.disabled ? 'true' : 'false'}>
        {children}
      </div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ id, children }: { id?: string; children: ReactNode }) => <div id={id}>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: function SelectItem({ value, children }: { value: string; children: ReactNode }) {
    const state = useContext(SelectContext);
    return (
      <button type="button" role="option" aria-selected={state.value === value} onClick={() => state.onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

// The menu is always open, so its items can be clicked without pointer events.
vi.mock('@weldsuite/ui/components/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

const { toast, state } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  state: {
    connection: null as unknown,
    loading: false,
    runs: [] as unknown[],
    records: [] as unknown[],
    sync: { mutate: vi.fn(), isPending: false },
    paused: { mutate: vi.fn(), isPending: false },
    update: { mutate: vi.fn(), isPending: false },
    repair: { mutate: vi.fn(), isPending: false },
    accountingEntities: [] as unknown,
  },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_test' }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: { get: async () => state.accountingEntities } }));
vi.mock('./connector-field-mapping-editor', () => ({
  ConnectorFieldMappingEditor: ({ connectionId }: { connectionId: string }) => <div data-testid="field-mappings">{connectionId}</div>,
}));
vi.mock('./moneybird-push-settings', () => ({
  MoneybirdPushSettingsPanel: () => <div data-testid="moneybird-push" />,
}));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useConnectorConnection: () => ({ data: { data: state.connection }, isLoading: state.loading }),
  useConnectorSyncRuns: () => ({ data: { data: state.runs } }),
  useConnectorRecords: () => ({ data: { data: state.records } }),
  useTriggerConnectorSync: () => state.sync,
  useSetConnectorPaused: () => state.paused,
  useUpdateConnector: () => state.update,
  useRepairLiveUpdates: () => state.repair,
}));

import { ConnectionDetails } from './connection-details';

const tc = en.settings.integrations.connectors;

const HOUR = 3_600_000;
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

function syncDef(settingKey: string, syncName = `${settingKey}-sync`, model = `${settingKey}-model`): ConnectorSyncDef {
  return { settingKey, syncName, model, internalEntity: settingKey };
}

function connectionOf(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: 'cc_1',
    provider: 'woocommerce',
    label: 'WooCommerce',
    icon: 'store',
    category: 'ecommerce',
    displayName: 'My shop',
    status: 'active',
    externalAccountId: 'shop.example.com',
    entityId: null,
    enabledSyncs: ['products'],
    direction: 'inbound',
    objectSyncDirections: {},
    authFields: [],
    syncs: [syncDef('products'), syncDef('orders')],
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    lastErrorAt: null,
    recordsSynced: 12,
    connectedAt: null,
    connectedBy: null,
    isConnected: true,
    webhookCount: 0,
    settings: {},
    ...overrides,
  } as ConnectorConnection;
}

function run(overrides: Partial<ConnectorSyncRun> = {}): ConnectorSyncRun {
  return {
    id: 'run_1',
    connectionId: 'cc_1',
    syncName: 'products-sync',
    model: 'products-model',
    status: 'success',
    trigger: 'manual',
    syncType: null,
    recordsAdded: 0,
    recordsUpdated: 0,
    recordsDeleted: 0,
    recordsCreated: 3,
    recordsModified: 2,
    recordsSkipped: 0,
    recordsFailed: 0,
    startedAt: hoursAgo(1),
    finishedAt: null,
    durationMs: null,
    error: null,
    createdAt: hoursAgo(1),
    ...overrides,
  };
}

function record(
  label: string,
  externalEntityType: string,
  internalEntityType = 'other',
  lastSyncedAt: string | null = null,
): ConnectorSyncedRecord {
  return {
    id: `rec_${label}`,
    label,
    externalEntityType,
    externalEntityId: `ext_${label}`,
    internalEntityType,
    internalEntityId: `int_${label}`,
    lastSyncedAt,
  };
}

interface Handlers {
  onDisconnect: Mock<(connection: ConnectorConnection) => void>;
  onOpenChange: Mock<(open: boolean) => void>;
}

function renderDetails(connection: ConnectorConnection, canManage = true, tab?: string): Handlers {
  state.connection = connection;
  const handlers: Handlers = {
    onDisconnect: vi.fn<(connection: ConnectorConnection) => void>(),
    onOpenChange: vi.fn<(open: boolean) => void>(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConnectionDetails
        connectionId={connection.id}
        onOpenChange={handlers.onOpenChange}
        onDisconnect={handlers.onDisconnect}
        canManage={canManage}
      />
    </QueryClientProvider>,
  );
  if (tab) fireEvent.mouseDown(screen.getByRole('tab', { name: tab }));
  return handlers;
}

function selectById(id: string): HTMLElement {
  return document.getElementById(id)!.closest<HTMLElement>('[data-testid="select"]')!;
}

function choose(select: HTMLElement, optionName: string): void {
  fireEvent.click(within(select).getByRole('option', { name: optionName }));
}

/** The row of the object with this label: its switch and, once on, its direction select. */
function objectRow(label: string): HTMLElement {
  return screen.getByText(label).closest<HTMLElement>('div.flex-col')!;
}

function switchOf(label: string): HTMLElement {
  return within(objectRow(label)).getByRole('switch');
}

function sentToUpdate(): Record<string, unknown> {
  const [input] = state.update.mutate.mock.calls[0] as [Record<string, unknown>];
  return input;
}

describe('ConnectionDetails header and actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.loading = false;
    state.runs = [];
    state.records = [];
    state.accountingEntities = [];
    state.sync.isPending = false;
    state.paused.isPending = false;
    state.update.isPending = false;
  });

  it('shows a spinner instead of the tabs while the connection loads', () => {
    state.loading = true;
    renderDetails(connectionOf());
    expect(screen.queryByRole('tab', { name: tc.records.title })).toBeNull();
  });

  it('names the connection with its status, account, record count and last sync', () => {
    renderDetails(connectionOf({ lastSyncAt: hoursAgo(2) }));
    expect(screen.getByText('My shop')).toBeTruthy();
    expect(screen.getByText(tc.status.active)).toBeTruthy();
    expect(screen.getByText(/shop\.example\.com · 12 records synced · Last sync 2 hours ago/)).toBeTruthy();
  });

  it('says a connection was never synced and falls back to the provider label', () => {
    renderDetails(connectionOf({ displayName: null, label: 'WooCommerce', lastSyncAt: null }));
    expect(screen.getByText('WooCommerce')).toBeTruthy();
    expect(screen.getByText(new RegExp(tc.lastSyncNever))).toBeTruthy();
  });

  it('writes a recent last sync in minutes', () => {
    renderDetails(connectionOf({ lastSyncAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    expect(screen.getByText(/5 minutes ago/)).toBeTruthy();
  });

  it.each(['auth_error', 'sync_error'] as const)('shows the last error banner when the status is %s', (status) => {
    renderDetails(connectionOf({ status, lastError: 'Token was revoked' }));
    expect(screen.getByText('Token was revoked')).toBeTruthy();
    expect(screen.getByText(tc.status[status])).toBeTruthy();
  });

  it('shows no error banner for an active connection that kept an old error', () => {
    renderDetails(connectionOf({ status: 'active', lastError: 'Old failure' }));
    expect(screen.queryByText('Old failure')).toBeNull();
  });

  it('starts a sync and confirms it, or reports that it could not start', () => {
    renderDetails(connectionOf());
    fireEvent.click(screen.getByRole('button', { name: tc.syncNow }));
    expect(state.sync.mutate).toHaveBeenCalledWith({ connectionId: 'cc_1', full: false }, expect.anything());
    const callbacks = state.sync.mutate.mock.calls[0]![1] as { onSuccess: () => void; onError: () => void };
    callbacks.onSuccess();
    expect(toast.success).toHaveBeenCalledWith(tc.syncStarted);
    callbacks.onError();
    expect(toast.error).toHaveBeenCalledWith(tc.syncFailed);
  });

  it('runs a full resync from the more actions menu', () => {
    renderDetails(connectionOf());
    fireEvent.click(screen.getByRole('menuitem', { name: tc.fullResync }));
    expect(state.sync.mutate).toHaveBeenCalledWith({ connectionId: 'cc_1', full: true }, expect.anything());
  });

  it('pauses an active connection and says whether it worked', () => {
    renderDetails(connectionOf({ status: 'active' }));
    fireEvent.click(screen.getByRole('menuitem', { name: tc.pause }));
    expect(state.paused.mutate).toHaveBeenCalledWith({ connectionId: 'cc_1', paused: true }, expect.anything());
    const callbacks = state.paused.mutate.mock.calls[0]![1] as { onSuccess: () => void; onError: () => void };
    callbacks.onSuccess();
    expect(toast.success).toHaveBeenCalledWith(tc.pausedToast);
    callbacks.onError();
    expect(toast.error).toHaveBeenCalledWith(tc.pauseFailed);
  });

  it('resumes a paused connection and says whether it worked', () => {
    renderDetails(connectionOf({ status: 'paused' }));
    expect(screen.queryByRole('menuitem', { name: tc.pause })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: tc.resume }));
    expect(state.paused.mutate).toHaveBeenCalledWith({ connectionId: 'cc_1', paused: false }, expect.anything());
    const callbacks = state.paused.mutate.mock.calls[0]![1] as { onSuccess: () => void; onError: () => void };
    callbacks.onSuccess();
    expect(toast.success).toHaveBeenCalledWith(tc.resumedToast);
    callbacks.onError();
    expect(toast.error).toHaveBeenCalledWith(tc.resumeFailed);
  });

  it('hands the connection to the disconnect flow', () => {
    const connection = connectionOf();
    const { onDisconnect } = renderDetails(connection);
    fireEvent.click(screen.getByRole('menuitem', { name: tc.disconnect }));
    expect(onDisconnect).toHaveBeenCalledWith(connection);
  });

  it('locks the actions for someone who cannot manage the connection', () => {
    renderDetails(connectionOf(), false);
    expect((screen.getByRole('button', { name: tc.syncNow }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: tc.moreActions }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables the sync and pause actions while they run', () => {
    state.sync.isPending = true;
    state.paused.isPending = true;
    renderDetails(connectionOf());
    expect((screen.getByRole('button', { name: tc.syncNow }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('menuitem', { name: tc.fullResync }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('menuitem', { name: tc.pause }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ConnectionDetails records tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.loading = false;
    state.runs = [];
    state.records = [];
  });

  it('invites the person to sync when nothing was imported yet', () => {
    renderDetails(connectionOf());
    expect(screen.getByText(tc.records.empty)).toBeTruthy();
  });

  it('lists the recent records with what kind they are and when they synced', () => {
    state.records = [
      record('bank-line', 'moneybird_financial_mutation'),
      record('bank-internal', 'x', 'bank_transaction'),
      record('account', 'moneybird_financial_account'),
      record('account-internal', 'x', 'bank_account'),
      record('scan', 'moneybird_receipt'),
      record('supplier-invoice', 'moneybird_purchase_invoice'),
      record('sales', 'moneybird_sales_invoice'),
      record('plain-invoice', 'invoice'),
      record('widget', 'woo_product'),
      record('basket', 'woo_order'),
      record('buyer', 'woo_customer'),
      record('company', 'moneybird_contact'),
      record('party', 'x', 'party'),
      record('person', 'x', 'person'),
      record('bill-internal', 'x', 'bill'),
      record('invoice-internal', 'x', 'invoice'),
      record('product-internal', 'x', 'product'),
      record('order-internal', 'x', 'order'),
      record('mystery', 'x', 'unknown', hoursAgo(3)),
    ];
    renderDetails(connectionOf());

    const typeOf = (label: string): string => screen.getByText(label).nextElementSibling!.textContent ?? '';
    expect(typeOf('bank-line')).toBe(tc.types.bankTransactions);
    expect(typeOf('bank-internal')).toBe(tc.types.bankTransactions);
    expect(typeOf('account')).toBe(tc.types.bankAccounts);
    expect(typeOf('account-internal')).toBe(tc.types.bankAccounts);
    expect(typeOf('scan')).toBe(tc.types.receipts);
    expect(typeOf('supplier-invoice')).toBe(tc.types.bills);
    expect(typeOf('sales')).toBe(tc.types.invoices);
    expect(typeOf('plain-invoice')).toBe(tc.types.invoices);
    expect(typeOf('widget')).toBe(tc.types.products);
    expect(typeOf('basket')).toBe(tc.types.orders);
    expect(typeOf('buyer')).toBe(tc.types.customers);
    expect(typeOf('company')).toBe(tc.types.contacts);
    expect(typeOf('party')).toBe(tc.types.contacts);
    expect(typeOf('person')).toBe(tc.types.contacts);
    expect(typeOf('bill-internal')).toBe(tc.types.bills);
    expect(typeOf('invoice-internal')).toBe(tc.types.invoices);
    expect(typeOf('product-internal')).toBe(tc.types.products);
    expect(typeOf('order-internal')).toBe(tc.types.orders);
    expect(typeOf('mystery')).toBe(`${tc.types.contacts} · 3 hours ago`);
    expect(screen.getByText('Showing the 19 most recent records')).toBeTruthy();
  });
});

describe('ConnectionDetails activity tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.loading = false;
    state.runs = [];
    state.records = [];
  });

  it('says so when no sync has run yet', () => {
    renderDetails(connectionOf(), true, tc.runs.title);
    expect(screen.getByText(tc.runs.empty)).toBeTruthy();
  });

  it('lists each run with its counts, trigger and status', () => {
    state.runs = [
      run({ id: 'r1', status: 'success', trigger: 'initial', recordsCreated: 5, recordsModified: 1 }),
      run({ id: 'r2', syncName: 'orders-sync', model: 'orders-model', status: 'partial', trigger: 'webhook', recordsSkipped: 4, recordsFailed: 2 }),
      run({ id: 'r3', syncName: 'receipt-sync', model: 'receipt-model', status: 'running', trigger: 'schedule' }),
      run({ id: 'r4', syncName: 'gone', model: 'WooCommerceCustomerOrder', status: 'error', trigger: 'cron' }),
      run({ id: 'r5', syncName: 'gone', model: 'PicqerPickList', status: 'weird' as ConnectorSyncRun['status'] }),
    ];
    renderDetails(connectionOf(), true, tc.runs.title);

    expect(screen.getByText('5 created · 1 updated')).toBeTruthy();
    expect(screen.getByText('3 created · 2 updated · 4 skipped · 2 failed')).toBeTruthy();
    expect(screen.getByText(tc.settings.products)).toBeTruthy();
    expect(screen.getByText(tc.settings.orders)).toBeTruthy();
    expect(screen.getByText(tc.types.receipts)).toBeTruthy();
    expect(screen.getByText('Customer Order')).toBeTruthy();
    expect(screen.getByText('Pick List')).toBeTruthy();
    expect(screen.getByText(/· Initial$/)).toBeTruthy();
    expect(screen.getByText(/· Webhook$/)).toBeTruthy();
    expect(screen.getByText(/· Scheduled$/)).toBeTruthy();
    expect(screen.getByText(/· cron$/)).toBeTruthy();
    expect(screen.getAllByText(/· Manual$/)).toHaveLength(1);
    expect(screen.getByText(tc.health.success)).toBeTruthy();
    expect(screen.getByText(tc.health.partial)).toBeTruthy();
    expect(screen.getByText(tc.health.running)).toBeTruthy();
    expect(screen.getByText(tc.health.error)).toBeTruthy();
    expect(screen.getByText('weird')).toBeTruthy();
  });

  it('shows a run error and up to three sample failures', () => {
    state.runs = [
      run({
        status: 'error',
        error: 'Shop returned 500',
        errorSamples: [
          { externalId: '101', message: 'Missing SKU' },
          { externalId: '-', message: 'No billing address' },
          { externalId: '103', message: 'Bad price' },
          { externalId: '104', message: 'Fourth is hidden' },
        ],
      }),
    ];
    renderDetails(connectionOf(), true, tc.runs.title);
    expect(screen.getByText('Shop returned 500')).toBeTruthy();
    expect(screen.getByText('101: Missing SKU')).toBeTruthy();
    expect(screen.getByText('No billing address')).toBeTruthy();
    expect(screen.getByText('103: Bad price')).toBeTruthy();
    expect(screen.queryByText(/Fourth is hidden/)).toBeNull();
  });
});

describe('ConnectionDetails settings tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.loading = false;
    state.runs = [];
    state.records = [];
    state.accountingEntities = [];
    state.update.isPending = false;
  });

  it.each([
    ['woocommerce', 'WooCommerce'],
    ['shopify', 'Shopify'],
    ['odoo', 'Odoo'],
  ])('shows only the shared sync settings for %s', (provider, label) => {
    renderDetails(connectionOf({ provider, label, displayName: label }), true, tc.settings.title);
    expect(screen.queryByText(tc.settings.entityLabel)).toBeNull();
    expect(screen.queryByText(tc.settings.importStartDateLabel)).toBeNull();
    expect(screen.queryByTestId('moneybird-push')).toBeNull();
    expect(screen.getByText(tc.settings.directionLabel)).toBeTruthy();
    expect(screen.getByTestId('field-mappings').textContent).toBe('cc_1');
    expect(screen.getByText(tc.webhookHint)).toBeTruthy();
  });

  it('lists each object once, even when two syncs share a setting', () => {
    renderDetails(
      connectionOf({ syncs: [syncDef('products'), syncDef('orders'), syncDef('orders', 'order-lines-sync')] }),
      true,
      tc.settings.title,
    );
    expect(screen.getAllByText(tc.settings.orders)).toHaveLength(1);
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('keeps Save settings off until something changes', () => {
    renderDetails(connectionOf(), true, tc.settings.title);
    expect((screen.getByRole('button', { name: tc.settings.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides Save settings and locks the controls for someone who cannot manage the connection', () => {
    renderDetails(connectionOf(), false, tc.settings.title);
    expect(screen.queryByRole('button', { name: tc.settings.save })).toBeNull();
    expect((switchOf(tc.settings.products) as HTMLButtonElement).disabled).toBe(true);
    expect(selectById('connection-direction').dataset.disabled).toBe('true');
  });

  it('turns objects on and off and saves the list of enabled syncs', () => {
    renderDetails(connectionOf({ enabledSyncs: ['products'] }), true, tc.settings.title);
    expect(switchOf(tc.settings.products).getAttribute('aria-checked')).toBe('true');
    expect(switchOf(tc.settings.orders).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(switchOf(tc.settings.orders));
    fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
    expect(sentToUpdate()).toEqual({ connectionId: 'cc_1', enabledSyncs: ['products', 'orders'] });

    state.update.mutate.mockClear();
    fireEvent.click(switchOf(tc.settings.products));
    fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
    expect(sentToUpdate()).toEqual({ connectionId: 'cc_1', enabledSyncs: ['orders'] });
  });

  it('counts an object as on when it is enabled by its sync name', () => {
    renderDetails(connectionOf({ enabledSyncs: ['orders-sync'] }), true, tc.settings.title);
    expect(switchOf(tc.settings.orders).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(switchOf(tc.settings.orders));
    fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
    expect(sentToUpdate()).toEqual({ connectionId: 'cc_1', enabledSyncs: [] });
  });

  it('saves the connection direction', () => {
    renderDetails(connectionOf(), true, tc.settings.title);
    expect(selectById('connection-direction').dataset.value).toBe('inbound');
    choose(selectById('connection-direction'), tc.settings.directionBidirectional);
    fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
    expect(sentToUpdate()).toEqual({ connectionId: 'cc_1', direction: 'bidirectional' });
  });

  it('lets an enabled object sync in another direction than the connection', () => {
    renderDetails(connectionOf({ enabledSyncs: ['products'], objectSyncDirections: { orders: 'outbound' } }), true, tc.settings.title);
    const productsSelect = within(objectRow(tc.settings.products)).getByTestId('select');
    expect(productsSelect.dataset.value).toBe('inbound');
    expect(within(objectRow(tc.settings.orders)).queryByTestId('select')).toBeNull();

    choose(productsSelect, tc.settings.directionOutbound);
    fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
    expect(sentToUpdate()).toEqual({ connectionId: 'cc_1', objectSyncDirections: { orders: 'outbound', products: 'outbound' } });
  });

  it('confirms a saved change and clears the draft', () => {
    renderDetails(connectionOf(), true, tc.settings.title);
    choose(selectById('connection-direction'), tc.settings.directionOutbound);
    fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
    const callbacks = state.update.mutate.mock.calls[0]![1] as { onSuccess: () => void; onError: () => void };
    callbacks.onSuccess();
    expect(toast.success).toHaveBeenCalledWith(tc.settings.saved);
    callbacks.onError();
    expect(toast.error).toHaveBeenCalledWith(tc.settings.saveFailed);
  });

  it('shows Save settings as busy while the update runs', () => {
    state.update.isPending = true;
    renderDetails(connectionOf(), true, tc.settings.title);
    expect((screen.getByRole('button', { name: tc.settings.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('drops unsaved changes when the sheet is closed', () => {
    const { onOpenChange } = renderDetails(connectionOf(), true, tc.settings.title);
    choose(selectById('connection-direction'), tc.settings.directionOutbound);
    expect((screen.getByRole('button', { name: tc.settings.save }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((screen.getByRole('button', { name: tc.settings.save }) as HTMLButtonElement).disabled).toBe(true);
    expect(selectById('connection-direction').dataset.value).toBe('inbound');
  });

  describe('for Stripe', () => {
    const stripe = (overrides: Partial<ConnectorConnection> = {}) =>
      connectionOf({
        provider: 'stripe',
        label: 'Stripe',
        displayName: 'Stripe',
        entityId: 'ent_1',
        settings: { importStartDate: '2026-01-01' },
        ...overrides,
      });

    it('asks which WeldBooks entity to import into, listing only active entities', async () => {
      state.accountingEntities = {
        data: [
          { id: 'ent_1', name: 'Weld BV', isActive: true },
          { id: 'ent_2', name: 'Weld UK', isActive: null },
          { id: 'ent_3', name: 'Old Co', isActive: false },
        ],
      };
      renderDetails(stripe(), true, tc.settings.title);
      expect(await screen.findByRole('option', { name: 'Weld BV' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'Weld UK' })).toBeTruthy();
      expect(screen.queryByRole('option', { name: 'Old Co' })).toBeNull();
      expect(selectById('connection-entity').dataset.value).toBe('ent_1');

      choose(selectById('connection-entity'), 'Weld UK');
      fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
      expect(sentToUpdate()).toEqual({ connectionId: 'cc_1', entityId: 'ent_2' });
    });

    it('reads an entity list that comes back as a bare array', async () => {
      state.accountingEntities = [{ id: 'ent_1', name: 'Weld BV' }];
      renderDetails(stripe(), true, tc.settings.title);
      expect(await screen.findByRole('option', { name: 'Weld BV' })).toBeTruthy();
    });

    it('says to create an entity first when the workspace has none', async () => {
      state.accountingEntities = { data: [] };
      renderDetails(stripe({ entityId: null }), true, tc.settings.title);
      expect(await screen.findAllByText(tc.settings.entityMissing)).toHaveLength(1);
      fireEvent.click(switchOf(tc.settings.orders));
      fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
      expect(toast.error).toHaveBeenCalledWith(tc.settings.entityMissing);
      expect(state.update.mutate).not.toHaveBeenCalled();
    });

    it('refuses to save until an entity is chosen', async () => {
      state.accountingEntities = { data: [{ id: 'ent_1', name: 'Weld BV' }] };
      renderDetails(stripe({ entityId: null }), true, tc.settings.title);
      await screen.findByRole('option', { name: 'Weld BV' });
      fireEvent.click(switchOf(tc.settings.orders));
      fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
      expect(toast.error).toHaveBeenCalledWith(tc.settings.entityRequired);
      expect(state.update.mutate).not.toHaveBeenCalled();
    });

    it('saves a new import start date, and refuses an empty one', async () => {
      state.accountingEntities = { data: [{ id: 'ent_1', name: 'Weld BV' }] };
      renderDetails(stripe(), true, tc.settings.title);
      await screen.findByRole('option', { name: 'Weld BV' });
      const input = screen.getByLabelText(tc.settings.importStartDateLabel) as HTMLInputElement;
      expect(input.value).toBe('2026-01-01');

      fireEvent.change(input, { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
      expect(toast.error).toHaveBeenCalledWith(tc.settings.importStartDateRequired);
      expect(state.update.mutate).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: '2026-03-01' } });
      fireEvent.click(screen.getByRole('button', { name: tc.settings.save }));
      await waitFor(() => expect(state.update.mutate).toHaveBeenCalledTimes(1));
      expect(sentToUpdate()).toEqual({ connectionId: 'cc_1', settings: { importStartDate: '2026-03-01' } });
    });

    it('does not ask for the import start date on other connectors', () => {
      renderDetails(connectionOf(), true, tc.settings.title);
      expect(screen.queryByLabelText(tc.settings.importStartDateLabel)).toBeNull();
    });
  });

  it('shows the Moneybird push settings and the entity picker for Moneybird', async () => {
    state.accountingEntities = { data: [{ id: 'ent_1', name: 'Weld BV' }] };
    renderDetails(connectionOf({ provider: 'moneybird', label: 'Moneybird', entityId: 'ent_1' }), true, tc.settings.title);
    expect(screen.getByTestId('moneybird-push')).toBeTruthy();
    expect(await screen.findByRole('option', { name: 'Weld BV' })).toBeTruthy();
  });
});
