import { createContext, useContext, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { ConnectorConnection, MoneybirdPushSettings } from '@/hooks/queries/use-connector-queries';

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

type PushStatusData = {
  enabled: boolean;
  pushedInvoices: number;
  pendingInvoices: number;
  failedInvoices: number;
  pushedPayouts: number;
  pendingPayouts: number;
  lastRun: {
    status: string;
    startedAt: string;
    error?: string | null;
    errorSamples?: Array<{ externalId: string; message: string }> | null;
  } | null;
};

const { toast, update, trigger, options } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  update: { mutate: vi.fn(), isPending: false },
  trigger: { mutate: vi.fn(), isPending: false },
  options: {
    loading: false,
    failed: false,
    data: undefined as unknown,
    status: undefined as unknown,
  },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/router', () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useMoneybirdPushOptions: () => ({
    data: options.data === undefined ? undefined : { data: options.data },
    isLoading: options.loading,
    isError: options.failed,
  }),
  useMoneybirdPushStatus: () => ({ data: options.status === undefined ? undefined : { data: options.status } }),
  useUpdateConnector: () => update,
  useTriggerMoneybirdPush: () => trigger,
}));

import { setRuntimeConfig } from '@/lib/runtime-config';
import { MoneybirdPushSettingsPanel } from './moneybird-push-settings';

const tc = en.settings.integrations.connectors;
const tp = tc.moneybirdPush;

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

const LEDGER_ACCOUNTS = [
  { id: 'la_cost', name: 'Bank fees', accountType: 'expense', accountId: '4500' },
  { id: 'la_sales_b', name: 'Services', accountType: 'revenue', accountId: '8010' },
  { id: 'la_sales_a', name: 'Consulting', accountType: 'revenue', accountId: '8000' },
  { id: 'la_other_a', name: 'Equipment', accountType: 'asset', accountId: '0100' },
  { id: 'la_other_b', name: 'Cash', accountType: 'asset', accountId: '1000' },
];

function loadedOptions(overrides: Record<string, unknown> = {}): unknown {
  return {
    ledgerAccounts: LEDGER_ACCOUNTS,
    financialAccounts: [{ id: 'fa_1', name: 'Stripe balance' }],
    taxRates: [{ id: 'tr_21', name: 'BTW 21%', percentage: 21 }],
    stripeConnections: [
      { id: 'cc_stripe_1', displayName: 'Main Stripe', externalAccountId: 'acct_1' },
      { id: 'cc_stripe_2', displayName: null, externalAccountId: 'acct_2' },
      { id: 'cc_stripe_3', displayName: null, externalAccountId: null },
    ],
    ...overrides,
  };
}

function idleStatus(overrides: Partial<PushStatusData> = {}): PushStatusData {
  return {
    enabled: false,
    pushedInvoices: 0,
    pendingInvoices: 0,
    failedInvoices: 0,
    pushedPayouts: 0,
    pendingPayouts: 0,
    lastRun: null,
    ...overrides,
  };
}

function connection(settings: Partial<MoneybirdPushSettings> = {}, overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: 'cc_mb',
    provider: 'moneybird',
    enabledSyncs: ['contacts'],
    direction: 'inbound',
    objectSyncDirections: {},
    settings: { moneybirdPush: { ...SETTINGS, ...settings } },
    ...overrides,
  } as ConnectorConnection;
}

function selectById(id: string): HTMLElement {
  return document.getElementById(id)!.closest<HTMLElement>('[data-testid="select"]')!;
}

function choose(select: HTMLElement, optionName: string): void {
  fireEvent.click(within(select).getByRole('option', { name: optionName }));
}

function save(): Record<string, unknown> {
  fireEvent.click(screen.getByRole('button', { name: tp.save }));
  const [input] = update.mutate.mock.calls[0] as [{ settings: { moneybirdPush: Record<string, unknown> } }];
  return input.settings.moneybirdPush;
}

describe('MoneybirdPushSettingsPanel setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    options.loading = false;
    options.failed = false;
    options.data = loadedOptions();
    options.status = idleStatus();
    update.isPending = false;
    trigger.isPending = false;
  });
  afterEach(() => setRuntimeConfig(null));

  it('shows a spinner instead of the pickers while the options load', () => {
    options.loading = true;
    options.data = undefined;
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.queryByText(tp.revenueLedgerLabel)).toBeNull();
    expect(screen.getByText(tp.statusTitle)).toBeTruthy();
  });

  it('says the options could not be loaded', () => {
    options.failed = true;
    options.data = undefined;
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.getByText(tp.optionsFailed)).toBeTruthy();
    expect(within(selectById('mb-push-revenue-ledger')).queryAllByRole('option')).toHaveLength(0);
  });

  it('points to the Stripe settings when no Stripe account is connected', () => {
    options.data = loadedOptions({ stripeConnections: [] });
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.getByText(tp.noStripeConnections)).toBeTruthy();
    expect(screen.getByRole('link', { name: tp.connectStripeLink }).getAttribute('href')).toBe('/settings/integrations/stripe');
  });

  it('lets the person choose which Stripe accounts to send from', () => {
    render(<MoneybirdPushSettingsPanel connection={connection({ sourceConnectionIds: ['cc_stripe_1'] })} canManage />);
    const first = screen.getByRole('checkbox', { name: 'Main Stripe' });
    expect(first.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: 'acct_2' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'cc_stripe_3' })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'acct_2' }));
    fireEvent.click(first);
    expect(save()).toMatchObject({ sourceConnectionIds: ['cc_stripe_2'] });
  });

  it('puts revenue accounts first in the ledger pickers, each group by name', () => {
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    const names = within(selectById('mb-push-revenue-ledger')).getAllByRole('option').map((option) => option.textContent);
    expect(names).toEqual(['Consulting', 'Services', 'Bank fees', 'Cash', 'Equipment']);
  });

  it('saves the revenue ledger and the start date', () => {
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    choose(selectById('mb-push-revenue-ledger'), 'Services');
    fireEvent.change(screen.getByLabelText(tp.startDateLabel), { target: { value: '2026-02-01' } });
    expect(save()).toMatchObject({ revenueLedgerAccountId: 'la_sales_b', startDate: '2026-02-01' });
  });

  it('clears the start date when the field is emptied', () => {
    render(<MoneybirdPushSettingsPanel connection={connection({ startDate: '2026-02-01' })} canManage />);
    const input = screen.getByLabelText(tp.startDateLabel) as HTMLInputElement;
    expect(input.value).toBe('2026-02-01');
    fireEvent.change(input, { target: { value: '' } });
    expect(save()).toMatchObject({ startDate: null });
  });

  it('offers the fee and payout ledgers once a payout account is chosen', () => {
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.queryByLabelText(tp.feeLedgerLabel)).toBeNull();
    expect(screen.queryByText(tp.payoutLedgerLabel)).toBeNull();

    choose(selectById('mb-push-financial-account'), 'Stripe balance');
    choose(selectById('mb-push-fee-ledger'), 'Bank fees');
    choose(selectById('mb-push-payout-ledger'), 'Cash');
    expect(save()).toMatchObject({
      financialAccountId: 'fa_1',
      feeLedgerAccountId: 'la_cost',
      payoutLedgerAccountId: 'la_other_b',
    });
  });

  it('drops the payout account again when "none" is chosen', () => {
    render(<MoneybirdPushSettingsPanel connection={connection({ financialAccountId: 'fa_1' })} canManage />);
    expect(selectById('mb-push-fee-ledger')).toBeTruthy();
    choose(selectById('mb-push-financial-account'), tp.financialAccountNone);
    expect(screen.queryByText(tp.payoutLedgerLabel)).toBeNull();
    expect(save()).toMatchObject({ financialAccountId: null });
  });

  it('picks a tax rate for each special case, or goes back to automatic', () => {
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    const taxSelect = (label: string): HTMLElement =>
      screen.getByText(label).closest<HTMLElement>('div.space-y-1\\.5')!.querySelector<HTMLElement>('[data-testid="select"]')!;

    for (const label of [tp.reverseChargeLabel, tp.outsideEuLabel, tp.exemptLabel, tp.noTaxLabel]) {
      choose(taxSelect(label), 'BTW 21% (21%)');
    }
    choose(taxSelect(tp.exemptLabel), tp.taxAutomatic);
    expect(save()).toMatchObject({
      taxRateOverrides: { reverseCharge: 'tr_21', outsideEu: 'tr_21', exempt: null, noTax: 'tr_21' },
    });
  });

  it('refuses to save an enabled push without a revenue ledger', () => {
    render(<MoneybirdPushSettingsPanel connection={connection({ revenueLedgerAccountId: null })} canManage />);
    fireEvent.change(screen.getByLabelText(tp.startDateLabel), { target: { value: '2026-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: tp.save }));
    expect(toast.error).toHaveBeenCalledWith(tp.revenueLedgerRequired);
    expect(update.mutate).not.toHaveBeenCalled();
  });

  it('saves a disabled push without a revenue ledger', () => {
    render(<MoneybirdPushSettingsPanel connection={connection({ enabled: false, revenueLedgerAccountId: null })} canManage />);
    fireEvent.change(screen.getByLabelText(tp.startDateLabel), { target: { value: '2026-02-01' } });
    expect(save()).toMatchObject({ enabled: false });
  });

  it('turns the push on from the switch', () => {
    render(<MoneybirdPushSettingsPanel connection={connection({ enabled: false })} canManage />);
    const toggle = screen.getByRole('switch', { name: tp.enableLabel });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(save()).toMatchObject({ enabled: true });
  });

  it('confirms a saved change and reports a failed one', () => {
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    fireEvent.change(screen.getByLabelText(tp.startDateLabel), { target: { value: '2026-02-01' } });
    save();
    const callbacks = update.mutate.mock.calls[0]![1] as { onSuccess: () => void; onError: () => void };
    act(() => callbacks.onSuccess());
    expect(toast.success).toHaveBeenCalledWith(tp.saved);
    expect((screen.getByRole('button', { name: tp.save }) as HTMLButtonElement).disabled).toBe(true);
    callbacks.onError();
    expect(toast.error).toHaveBeenCalledWith(tp.saveFailed);
  });

  it('keeps Save off until something changes, and while a save runs', () => {
    const { rerender } = render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect((screen.getByRole('button', { name: tp.save }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(tp.startDateLabel), { target: { value: '2026-02-01' } });
    expect((screen.getByRole('button', { name: tp.save }) as HTMLButtonElement).disabled).toBe(false);

    update.isPending = true;
    rerender(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect((screen.getByRole('button', { name: tp.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts again from the saved settings when the connection changes', () => {
    const { rerender } = render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    fireEvent.change(screen.getByLabelText(tp.startDateLabel), { target: { value: '2026-02-01' } });
    rerender(<MoneybirdPushSettingsPanel connection={connection({ startDate: '2025-12-01' }, { id: 'cc_other' })} canManage />);
    expect((screen.getByLabelText(tp.startDateLabel) as HTMLInputElement).value).toBe('2025-12-01');
    expect((screen.getByRole('button', { name: tp.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses empty settings for a connection that has never saved any', () => {
    render(<MoneybirdPushSettingsPanel connection={{ ...connection(), settings: {} } as ConnectorConnection} canManage />);
    expect(screen.getByRole('switch', { name: tp.enableLabel }).getAttribute('aria-checked')).toBe('false');
    expect(selectById('mb-push-revenue-ledger').dataset.value).toBe('');
  });

  it('is read-only for someone who cannot manage the connection', () => {
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage={false} />);
    expect(screen.queryByRole('button', { name: tp.save })).toBeNull();
    expect((screen.getByRole('switch', { name: tp.enableLabel }) as HTMLButtonElement).disabled).toBe(true);
    expect(selectById('mb-push-revenue-ledger').dataset.disabled).toBe('true');
    expect((screen.getByRole('button', { name: tp.sendNow }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('chooses the expense, fee and payout ledgers on an edition with the two-way sync', () => {
    setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'connect', 'books'], unavailableFeatures: [] });
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    choose(selectById('mb-push-expense-ledger'), 'Bank fees');
    expect(save()).toMatchObject({ expenseLedgerAccountId: 'la_cost' });
  });
});

describe('MoneybirdPushSettingsPanel push status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    options.loading = false;
    options.failed = false;
    options.data = loadedOptions();
    options.status = idleStatus();
    trigger.isPending = false;
  });

  it('shows the counts and that nothing has run yet', () => {
    options.status = idleStatus({ pushedInvoices: 4, pendingInvoices: 2, pushedPayouts: 7, pendingPayouts: 1 });
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.getByText('4 invoices pushed')).toBeTruthy();
    expect(screen.getByText('2 invoices pending')).toBeTruthy();
    expect(screen.getByText('7 payouts pushed')).toBeTruthy();
    expect(screen.getByText('1 payouts pending')).toBeTruthy();
    expect(screen.getByText(tp.neverRun)).toBeTruthy();
  });

  it('shows zero counts before the status has loaded', () => {
    options.status = undefined;
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.getByText('0 invoices pushed')).toBeTruthy();
    expect((screen.getByRole('button', { name: tp.sendNow }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the last run with its status, time and error', () => {
    options.status = idleStatus({
      lastRun: { status: 'error', startedAt: '2026-11-20T10:00:00.000Z', error: 'Moneybird said no' },
    });
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.getByText(tc.health.error)).toBeTruthy();
    expect(screen.getByText(new Date('2026-11-20T10:00:00.000Z').toLocaleString('en'))).toBeTruthy();
    expect(screen.getByText('Moneybird said no')).toBeTruthy();
  });

  it('shows the last run without a time it cannot read, and keeps an unknown status as it is', () => {
    options.status = idleStatus({ lastRun: { status: 'queued', startedAt: 'not a date' } });
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.getByText('queued')).toBeTruthy();
    expect(screen.queryByText(tp.neverRun)).toBeNull();
  });

  it('counts failed invoices and lists up to five sample failures', () => {
    options.status = idleStatus({
      failedInvoices: 3,
      lastRun: {
        status: 'partial',
        startedAt: '2026-11-20T10:00:00.000Z',
        errorSamples: [
          { externalId: 'inv_1', message: 'No contact' },
          { externalId: '-', message: 'No tax rate' },
          { externalId: 'inv_3', message: 'Bad total' },
          { externalId: 'inv_4', message: 'Closed period' },
          { externalId: 'inv_5', message: 'Duplicate' },
          { externalId: 'inv_6', message: 'Sixth is hidden' },
        ],
      },
    });
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect(screen.getByText('3 invoices failed')).toBeTruthy();
    expect(screen.getByText(tp.errorSamplesTitle)).toBeTruthy();
    expect(screen.getByText('inv_1: No contact')).toBeTruthy();
    expect(screen.getByText('No tax rate')).toBeTruthy();
    expect(screen.getByText('inv_5: Duplicate')).toBeTruthy();
    expect(screen.queryByText(/Sixth is hidden/)).toBeNull();
  });

  it('sends now when the push is on, and confirms or reports the result', () => {
    options.status = idleStatus({ enabled: true });
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    fireEvent.click(screen.getByRole('button', { name: tp.sendNow }));
    expect(trigger.mutate).toHaveBeenCalledWith('cc_mb', expect.anything());
    const callbacks = trigger.mutate.mock.calls[0]![1] as { onSuccess: () => void; onError: () => void };
    callbacks.onSuccess();
    expect(toast.success).toHaveBeenCalledWith(tp.pushStarted);
    callbacks.onError();
    expect(toast.error).toHaveBeenCalledWith(tp.pushFailed);
  });

  it('keeps Send now off while a push is running', () => {
    options.status = idleStatus({ enabled: true, lastRun: { status: 'running', startedAt: '2026-11-20T10:00:00.000Z' } });
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect((screen.getByRole('button', { name: tp.sendNow }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps Send now off while the request to push is being sent', () => {
    options.status = idleStatus({ enabled: true });
    trigger.isPending = true;
    render(<MoneybirdPushSettingsPanel connection={connection()} canManage />);
    expect((screen.getByRole('button', { name: tp.sendNow }) as HTMLButtonElement).disabled).toBe(true);
  });
});
