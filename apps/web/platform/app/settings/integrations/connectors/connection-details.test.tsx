import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { en } from '@weldsuite/i18n/locales/en';
import type { ConnectorConnection } from '@/hooks/queries/use-connector-queries';

vi.mock('@/lib/i18n/provider', async () => {
  const locale = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: locale.en, language: 'en', format: interpolate }) };
});
const { toast, repair, mutation, state } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  repair: { mutate: vi.fn(), isPending: false },
  mutation: () => ({ mutate: vi.fn(), isPending: false }),
  state: { connection: null as unknown },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_test' }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: { get: async () => [] } }));
vi.mock('./connector-field-mapping-editor', () => ({ ConnectorFieldMappingEditor: () => null }));
vi.mock('./moneybird-push-settings', () => ({ MoneybirdPushSettingsPanel: () => null }));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useConnectorConnection: () => ({ data: { data: state.connection }, isLoading: false }),
  useConnectorSyncRuns: () => ({ data: { data: [] } }),
  useConnectorRecords: () => ({ data: { data: [] } }),
  useTriggerConnectorSync: mutation,
  useSetConnectorPaused: mutation,
  useUpdateConnector: mutation,
  useRepairLiveUpdates: () => repair,
}));

import { setRuntimeConfig } from '@/lib/runtime-config';
import { ConnectionDetails } from './connection-details';

const tc = en.settings.integrations.connectors;

const SYNCS = [
  ['contacts', 'moneybird-contacts'],
  ['invoices', 'moneybird-sales-invoices'],
  ['bankTransactions', 'moneybird-financial-mutations'],
].map(([settingKey, syncName]) => ({ settingKey, syncName, model: syncName, internalEntity: settingKey }));

function moneybird(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: 'cc_mb',
    provider: 'moneybird',
    label: 'Moneybird',
    icon: 'book-open',
    category: 'accounting',
    displayName: 'Books',
    status: 'active',
    externalAccountId: '123',
    entityId: null,
    enabledSyncs: ['contacts', 'invoices', 'bankTransactions'],
    direction: 'inbound',
    objectSyncDirections: {},
    authFields: [],
    syncs: SYNCS,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    lastErrorAt: null,
    recordsSynced: 0,
    connectedAt: null,
    connectedBy: null,
    isConnected: true,
    webhookCount: 0,
    settings: {},
    ...overrides,
  } as ConnectorConnection;
}

function renderSettings(connection: ConnectorConnection, canManage = true) {
  state.connection = connection;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<ConnectionDetails connectionId={connection.id} onOpenChange={vi.fn()} onDisconnect={vi.fn()} canManage={canManage} />, { wrapper });
  fireEvent.mouseDown(screen.getByRole('tab', { name: tc.settings.title }));
}

/** A Kubernetes (EU) edition, where the two-way sync exists. */
function onEu(): void {
  setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'connect', 'books'], unavailableFeatures: [] });
}

describe('ConnectionDetails for Moneybird', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => setRuntimeConfig(null));

  it('shows live updates off with a way to turn them on, where the two-way sync exists', () => {
    onEu();
    renderSettings(moneybird({ webhookCount: 0 }));
    expect(screen.getByText(tc.moneybirdLive.title)).toBeTruthy();
    expect(screen.getByText(tc.moneybirdLive.off)).toBeTruthy();
    expect(screen.getByText(tc.moneybirdLive.offHint)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: tc.moneybirdLive.turnOn }));
    expect(repair.mutate).toHaveBeenCalledWith('cc_mb', expect.anything());
    const callbacks = repair.mutate.mock.calls[0][1] as {
      onSuccess: (result: { data: { warning: string | null } }) => void;
      onError: () => void;
    };
    callbacks.onSuccess({ data: { warning: null } });
    expect(toast.success).toHaveBeenCalledWith(tc.moneybirdLive.turnedOn);
    callbacks.onSuccess({ data: { warning: 'Still off' } });
    expect(toast.error).toHaveBeenCalledWith('Still off');
    callbacks.onError();
    expect(toast.error).toHaveBeenCalledWith(tc.moneybirdLive.turnOnFailed);
  });

  it('shows live updates on without the button, and none for someone who cannot manage', () => {
    onEu();
    renderSettings(moneybird({ webhookCount: 2 }), false);
    expect(screen.getByText(tc.moneybirdLive.on)).toBeTruthy();
    expect(screen.getByText(tc.moneybirdLive.onHint)).toBeTruthy();
    expect(screen.queryByRole('button', { name: tc.moneybirdLive.turnOn })).toBeNull();
  });

  it('keeps bank data inbound and explains sending once an object sends', () => {
    onEu();
    renderSettings(moneybird({ objectSyncDirections: { contacts: 'bidirectional' } }));
    expect(screen.getByText(tc.settings.directionInboundOnly)).toBeTruthy();
    expect(screen.getByText(tc.settings.directionInboundOnlyHint)).toBeTruthy();
    expect(screen.getByText(tc.moneybirdLive.twoWayTitle)).toBeTruthy();
  });

  it('does not explain sending while every object only imports', () => {
    onEu();
    renderSettings(moneybird({ objectSyncDirections: { bankTransactions: 'outbound' } }));
    expect(screen.queryByText(tc.moneybirdLive.twoWayTitle)).toBeNull();
  });

  it('leaves the screen as it was on Global', () => {
    renderSettings(moneybird({ objectSyncDirections: { contacts: 'bidirectional' } }));
    expect(screen.queryByText(tc.moneybirdLive.title)).toBeNull();
    expect(screen.queryByText(tc.settings.directionInboundOnly)).toBeNull();
    expect(screen.queryByText(tc.moneybirdLive.twoWayTitle)).toBeNull();
  });
});
