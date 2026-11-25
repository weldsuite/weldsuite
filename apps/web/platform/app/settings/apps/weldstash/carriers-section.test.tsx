import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { CarrierAccount, CarrierCatalogEntry } from '@weldsuite/app-api-client/schemas/shipping';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  can: true,
  available: true,
  carriers: { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: ReturnType<typeof vi.fn>;
  },
  catalog: { data: undefined as unknown },
  update: vi.fn(),
  test: vi.fn(),
  testPending: false,
  remove: vi.fn(),
  removePending: false,
  canceled: [] as string[],
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (key: string) => state.can && !state.canceled.includes(key) }),
}));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => state.available }));
vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  useCarriers: () => state.carriers,
  useCarrierCatalog: () => state.catalog,
  useUpdateCarrier: () => ({ mutate: state.update }),
  useTestCarrier: () => ({ mutate: state.test, isPending: state.testPending }),
  useDeleteCarrier: () => ({ mutateAsync: state.remove, isPending: state.removePending }),
}));
vi.mock('./carrier-dialog', () => ({
  CarrierDialog: ({ carrier, onOpenChange }: { carrier?: CarrierAccount; onOpenChange: (open: boolean) => void }) => (
    <div role="dialog" aria-label="carrier dialog">
      {carrier ? `editing ${carrier.name}` : 'connecting'}
      <button type="button" onClick={() => onOpenChange(false)}>
        close dialog
      </button>
    </div>
  ),
}));

import { CarriersSection } from './carriers-section';

const t = en.weldstash.shipping.carriers;

function account(over: Partial<CarrierAccount> = {}): CarrierAccount {
  return {
    id: 'car_1',
    name: 'PostNL main',
    code: 'postnl',
    carrierName: 'PostNL',
    contract: 'own',
    isDefault: false,
    isActive: true,
    accountNumber: null,
    settings: {},
    credentials: { apiKey: '••••abcd' },
    hasCredentials: true,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

const catalogEntry = { code: 'postnl', name: 'PostNL' } as CarrierCatalogEntry;

function setCarriers(rows: CarrierAccount[]) {
  state.carriers = { data: rows, isLoading: false, isError: false, error: null, refetch: vi.fn() };
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, index = 0) {
  await user.click(screen.getAllByRole('button', { name: 'Open row actions' })[index]!);
}

beforeEach(() => {
  polyfillRadixSelect();
  state.can = true;
  state.canceled = [];
  state.available = true;
  state.catalog = { data: [catalogEntry] };
  state.testPending = false;
  state.removePending = false;
  state.update.mockReset();
  state.test.mockReset();
  state.remove.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  setCarriers([account()]);
});

describe('CarriersSection', () => {
  it('renders nothing when the edition has no shipping or the user cannot read carriers', () => {
    state.available = false;
    const { container, unmount } = renderWithProviders(<CarriersSection />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    state.available = true;
    state.canceled = ['weldstash:carriers:read'];
    const second = renderWithProviders(<CarriersSection />);
    expect(second.container).toBeEmptyDOMElement();
  });

  it('shows a spinner while loading, an error with retry, and an empty state', async () => {
    const user = userEvent.setup();
    state.carriers = { data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() };
    const first = renderWithProviders(<CarriersSection />);
    expect(screen.queryByText(t.empty)).not.toBeInTheDocument();
    first.unmount();

    const refetch = vi.fn();
    state.carriers = { data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch };
    const second = renderWithProviders(<CarriersSection />);
    expect(screen.getByText('boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
    second.unmount();

    state.carriers = { data: undefined, isLoading: false, isError: true, error: {}, refetch };
    const third = renderWithProviders(<CarriersSection />);
    expect(screen.getByText(t.loadError)).toBeInTheDocument();
    third.unmount();

    setCarriers([]);
    renderWithProviders(<CarriersSection />);
    expect(screen.getByText(t.empty)).toBeInTheDocument();
    expect(screen.getByText(t.emptyDescription)).toBeInTheDocument();
  });

  it('lists the account with its contract, status badges and masked credentials', () => {
    setCarriers([
      account({ isDefault: true, settings: { sandbox: true } }),
      account({ id: 'car_2', name: 'DHL via WeldSuite', carrierName: 'DHL Parcel', contract: 'weldsuite', isActive: false, credentials: {}, hasCredentials: false }),
      account({ id: 'car_3', name: 'No keys', credentials: {}, hasCredentials: false }),
    ]);
    renderWithProviders(<CarriersSection />);
    expect(screen.getByText('PostNL main')).toBeInTheDocument();
    expect(screen.getByText(t.default)).toBeInTheDocument();
    expect(screen.getByText(t.sandbox)).toBeInTheDocument();
    expect(screen.getByText('apiKey ••••abcd')).toBeInTheDocument();
    expect(screen.getByText(t.inactive)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(t.noCredentials)).toBeInTheDocument();
    expect(screen.getAllByText(en.weldstash.shipping.contracts.weldsuite).length).toBeGreaterThan(0);
  });

  it('connects a new carrier, disabled until the catalog has loaded', async () => {
    const user = userEvent.setup();
    state.catalog = { data: undefined };
    const first = renderWithProviders(<CarriersSection />);
    expect(screen.getByRole('button', { name: t.connect })).toBeDisabled();
    first.unmount();

    state.catalog = { data: [catalogEntry] };
    renderWithProviders(<CarriersSection />);
    await user.click(screen.getByRole('button', { name: t.connect }));
    expect(screen.getByRole('dialog', { name: 'carrier dialog' })).toHaveTextContent('connecting');
    await user.click(screen.getByRole('button', { name: 'close dialog' }));
    expect(screen.queryByRole('dialog', { name: 'carrier dialog' })).not.toBeInTheDocument();
  });

  it('hides the connect button without create permission and the row actions without update or delete', () => {
    state.canceled = ['weldstash:carriers:create', 'weldstash:carriers:update', 'weldstash:carriers:delete'];
    renderWithProviders(<CarriersSection />);
    expect(screen.queryByRole('button', { name: t.connect })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open row actions' })).not.toBeInTheDocument();
  });

  it('edits an account in the dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.edit }));
    expect(screen.getByRole('dialog', { name: 'carrier dialog' })).toHaveTextContent('editing PostNL main');
  });

  it('tests the connection and toasts the result', async () => {
    const user = userEvent.setup();
    state.test.mockImplementation((_id: string, opts: { onSuccess: (r: { ok: boolean }) => void }) => opts.onSuccess({ ok: true }));
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.test }));
    expect(state.test).toHaveBeenCalledWith('car_1', expect.any(Object));
    expect(toast.success).toHaveBeenCalledWith(t.testOk);
  });

  it('toasts a failed test result', async () => {
    const user = userEvent.setup();
    state.test.mockImplementation((_id: string, opts: { onSuccess: (r: { ok: boolean }) => void }) => opts.onSuccess({ ok: false }));
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.test }));
    expect(toast.error).toHaveBeenCalledWith(t.testFailed);
  });

  it('shows the carrier error notice when the test call fails', async () => {
    const user = userEvent.setup();
    const err = new ApiError('Request failed', 502, { error: { code: 'CARRIER_UNAVAILABLE', message: 'down', details: { messages: ['Invalid API key'] } } });
    state.test.mockImplementation((_id: string, opts: { onError: (e: unknown) => void }) => opts.onError(err));
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.test }));
    expect(toast.error).toHaveBeenCalledWith(t.testFailed);
    expect(await screen.findByText('Invalid API key')).toBeInTheDocument();
  });

  it('offers no test for a WeldSuite contract and no default for a default or inactive account', async () => {
    const user = userEvent.setup();
    setCarriers([account({ id: 'car_2', contract: 'weldsuite' }), account({ isDefault: true }), account({ id: 'car_4', isActive: false })]);
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user, 0);
    expect(await screen.findByRole('menuitem', { name: t.setDefault })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: t.test })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await openRowMenu(user, 1);
    expect(screen.queryByRole('menuitem', { name: t.setDefault })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await openRowMenu(user, 2);
    expect(screen.queryByRole('menuitem', { name: t.setDefault })).not.toBeInTheDocument();
  });

  it('makes an account the default and reports success or the server message', async () => {
    const user = userEvent.setup();
    state.update.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) => opts.onSuccess());
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.setDefault }));
    expect(state.update).toHaveBeenCalledWith({ id: 'car_1', data: { isDefault: true } }, expect.any(Object));
    expect(toast.success).toHaveBeenCalledWith(t.defaultSet);

    state.update.mockImplementation((_vars: unknown, opts: { onError: (e: Error) => void }) => opts.onError(new Error('')));
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.setDefault }));
    expect(toast.error).toHaveBeenCalledWith(t.actionFailed);

    state.update.mockImplementation((_vars: unknown, opts: { onError: (e: Error) => void }) => opts.onError(new Error('Nope')));
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.setDefault }));
    expect(toast.error).toHaveBeenCalledWith('Nope');
  });

  it('asks before deleting, then removes the account', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.delete }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t.deleteTitle)).toBeInTheDocument();
    expect(within(dialog).getByText(t.deleteDescription.replace('{name}', 'PostNL main'))).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: t.delete }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('car_1'));
    expect(toast.success).toHaveBeenCalledWith(t.deleted);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the confirm dialog open and toasts when deleting fails', async () => {
    const user = userEvent.setup();
    state.remove.mockRejectedValue(new Error(''));
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.delete }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: t.delete }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.actionFailed));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not delete when the confirm dialog is cancelled', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CarriersSection />);
    await openRowMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.delete }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(state.remove).not.toHaveBeenCalled();
  });
});
