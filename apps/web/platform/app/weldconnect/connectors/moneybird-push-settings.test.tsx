import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { ConnectorConnection, MoneybirdPushSettings } from '@/hooks/queries/use-connector-queries';

vi.mock('@/lib/i18n/provider', async () => {
  const locale = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: locale.en, language: 'en', format: interpolate }) };
});
const { update, trigger } = vi.hoisted(() => ({
  update: { mutate: vi.fn(), isPending: false },
  trigger: { mutate: vi.fn(), isPending: false },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/router', () => ({ Link: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useMoneybirdPushOptions: () => ({
    data: {
      data: {
        ledgerAccounts: [{ id: 'la_revenue', name: 'Revenue', accountType: 'revenue', accountId: '8000' }],
        financialAccounts: [],
        taxRates: [],
        stripeConnections: [],
      },
    },
    isLoading: false,
    isError: false,
  }),
  useMoneybirdPushStatus: () => ({
    data: {
      data: {
        enabled: false,
        pushedInvoices: 0,
        pendingInvoices: 0,
        failedInvoices: 0,
        pushedPayouts: 0,
        pendingPayouts: 0,
        lastRun: null,
      },
    },
  }),
  useUpdateConnector: () => update,
  useTriggerMoneybirdPush: () => trigger,
}));

import { setRuntimeConfig } from '@/lib/runtime-config';
import { MoneybirdPushSettingsPanel } from './moneybird-push-settings';

const tp = en.weldconnect.connectors.moneybirdPush;

const SETTINGS: MoneybirdPushSettings = {
  enabled: true,
  sourceConnectionIds: [],
  revenueLedgerAccountId: 'la_revenue',
  financialAccountId: null,
  feeLedgerAccountId: null,
  payoutLedgerAccountId: null,
  taxRateOverrides: { reverseCharge: null, outsideEu: null, exempt: null, noTax: null },
  startDate: null,
};

function connection(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: 'cc_mb',
    provider: 'moneybird',
    enabledSyncs: ['contacts', 'invoices', 'bankTransactions'],
    direction: 'inbound',
    objectSyncDirections: {},
    settings: { moneybirdPush: SETTINGS },
    ...overrides,
  } as ConnectorConnection;
}

/** Turns the push off and saves: the settings sent are the saved payload. */
function saveSent(): Record<string, unknown> {
  fireEvent.click(screen.getByRole('switch', { name: tp.enableLabel }));
  fireEvent.click(screen.getByRole('button', { name: tp.save }));
  const [input] = update.mutate.mock.calls[0] as [{ settings: { moneybirdPush: Record<string, unknown> } }];
  return input.settings.moneybirdPush;
}

/** A Kubernetes (EU) edition, where the two-way sync exists. */
function onEu(): void {
  setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'connect', 'books'], unavailableFeatures: [] });
}

describe('MoneybirdPushSettingsPanel', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => setRuntimeConfig(null));

  it('offers the expense ledger and sends it where the two-way sync exists', () => {
    onEu();
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.getByText(tp.expenseLedgerLabel)).toBeTruthy();
    expect(screen.getByText(tp.twoWayLedgerHint)).toBeTruthy();
    expect(saveSent()).toMatchObject({ enabled: false, expenseLedgerAccountId: null });
  });

  it('leaves the expense ledger out on Global', () => {
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.queryByText(tp.expenseLedgerLabel)).toBeNull();
    expect(saveSent()).not.toHaveProperty('expenseLedgerAccountId');
  });

  it('lets Send now run for an object that sends, without the Stripe push', () => {
    onEu();
    render(
      <MoneybirdPushSettingsPanel
        connection={connection({ objectSyncDirections: { contacts: 'bidirectional' } })}
        canManage
      />,
    );
    const sendNow = screen.getByRole('button', { name: tp.sendNow });
    expect((sendNow as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendNow);
    expect(trigger.mutate).toHaveBeenCalledWith('cc_mb', expect.anything());
  });

  it('keeps Send now off while nothing sends', () => {
    onEu();
    render(
      <MoneybirdPushSettingsPanel
        connection={connection({ objectSyncDirections: { bankTransactions: 'outbound' } })}
        canManage
      />,
    );
    expect((screen.getByRole('button', { name: tp.sendNow }) as HTMLButtonElement).disabled).toBe(true);
  });
});
