import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';

const env = vi.hoisted(() => ({
  plans: [] as unknown[],
  loading: false,
  isError: false,
  error: null as Error | null,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  queryArgs: vi.fn(),
  permissions: new Set<string>(),
  dismiss: vi.fn(),
  create: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  useInfinitePlans: (query: unknown) => {
    env.queryArgs(query);
    return {
      data: { pages: [{ data: env.plans, pagination: { hasMore: false, cursor: null, totalCount: env.plans.length } }] },
      isLoading: env.loading,
      isError: env.isError,
      error: env.error,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: env.fetchNextPage,
      refetch: env.refetch,
    };
  },
  useDismissPlan: () => ({ mutateAsync: env.dismiss, isPending: false }),
  useCreatePurchaseOrdersFromPlans: () => ({ mutateAsync: env.create, isPending: false }),
}));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useSendPurchaseOrderToOdoo: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashSuppliers: () => ({
    data: { data: [{ id: 's1', name: 'Acme', minimumOrderValue: '400.00' }, { id: 's2', name: 'Zeta', minimumOrderValue: null }] },
  }),
  useWeldstashWarehouses: () => ({ data: { data: [{ id: 'w1', name: 'Main' }] } }),
}));

import { ReorderTab } from './reorder-tab';

function plan(overrides: Partial<ReplenishmentPlan> = {}): ReplenishmentPlan {
  return {
    id: 'plan_1',
    itemKey: 'p1||w1',
    productId: 'p1',
    variantId: null,
    warehouseId: 'w1',
    runId: null,
    computedAt: '2026-11-18T02:00:00Z',
    method: 'seasonal',
    confidence: 'ok',
    historyDays: 365,
    nonzeroDays: 200,
    avgDailyDemand: '5.2000',
    demandStdDev: null,
    seasonality: null,
    forecast30d: null,
    forecast90d: null,
    leadTimeDays: 20,
    reviewPeriodDays: 7,
    serviceLevel: '0.950',
    productSupplierId: null,
    supplierId: 's1',
    safetyStock: 36,
    reorderPoint: 140,
    orderUpTo: 260,
    onHand: 50,
    allocated: 5,
    incoming: 10,
    openDemand: 0,
    inventoryPosition: 55,
    daysOfCover: '8.7',
    stockoutDate: '2999-01-01',
    suggestedQty: 100,
    suggestedValue: '250.00',
    reviewStatus: 'open',
    dismissedUntil: null,
    dismissedBy: null,
    dismissedQty: null,
    purchaseOrderId: null,
    productName: 'Widget',
    productSku: 'W-1',
    variantName: null,
    warehouseName: 'Main',
    warehouseManagedByConnectionId: null,
    supplierName: 'Acme',
    currency: 'EUR',
    unitCost: '2.5000',
    minOrderQty: null,
    orderMultiple: 1,
    ...overrides,
  };
}

const noop = () => undefined;

beforeEach(() => {
  env.plans = [];
  env.loading = false;
  env.isError = false;
  env.error = null;
  env.hasNextPage = false;
  env.fetchNextPage.mockReset();
  env.refetch.mockReset();
  env.queryArgs.mockReset();
  env.toast.success.mockReset();
  env.toast.error.mockReset();
  env.permissions = new Set(['purchase_orders:create', 'inventory:update']);
  env.dismiss.mockReset().mockResolvedValue({});
  env.create.mockReset().mockResolvedValue({ purchaseOrders: [], skipped: [] });
});

describe('ReorderTab', () => {
  it('groups the plans by supplier, no supplier last, with their numbers', () => {
    env.plans = [
      plan({ id: 'a', productName: 'Zebra lamp', supplierId: 's2', supplierName: 'Zeta' }),
      plan({ id: 'b', productName: 'Desk lamp' }),
      plan({ id: 'c', productName: 'Loose bulb', supplierId: null, supplierName: null, unitCost: null }),
    ];
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Acme')).toBeLessThan(text.indexOf('Zeta'));
    expect(text.indexOf('Zeta')).toBeLessThan(text.indexOf('No supplier'));
    expect(screen.getByText('Desk lamp')).toBeInTheDocument();
    expect(screen.getByText('Link a supplier on the product to order it')).toBeInTheDocument();
    // Available = on hand - reserved = 45
    expect(screen.getAllByText('45').length).toBeGreaterThan(0);
  });

  it('selects rows, edits a quantity and lists the warnings before creating orders', async () => {
    env.plans = [plan({ id: 'a' }), plan({ id: 'b', productName: 'Desk lamp', productSku: 'D-1' })];
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);

    const create = screen.getByRole('button', { name: /Create draft purchase orders/ });
    expect(create).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select Widget' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Desk lamp' }));
    expect(screen.getByText(/2 selected/)).toBeInTheDocument();

    const quantity = screen.getByLabelText('Quantity to order for Desk lamp');
    await user.clear(quantity);
    await user.type(quantity, '20');
    expect(quantity).toHaveValue(20);

    await user.click(create);
    // Acme: 100 x 2.50 + 20 x 2.50 = 300, under its 400 minimum.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Acme has a minimum order value')).toBeInTheDocument();
    expect(within(dialog).getByText(/under the .*400.* minimum/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Create orders' }));
    expect(env.create).toHaveBeenCalledWith({ planIds: ['a', 'b'], quantities: { b: 20 } });
  });

  it('keeps the selection tools away from people who cannot create orders', () => {
    env.permissions = new Set();
    env.plans = [plan()];
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create draft purchase orders/ })).not.toBeInTheDocument();
  });

  it('shows an empty state with a way to the settings when there is nothing to reorder', async () => {
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={onOpenSettings} />);
    expect(screen.getByText('Nothing to reorder')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('points at the CSV import when some items have little history', () => {
    env.plans = [plan({ confidence: 'low' })];
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByText(/little or no sales history/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import sales history' })).toBeInTheDocument();
  });
});

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

describe('ReorderTab selection, quantities and snoozing', () => {
  it('selects every item of a supplier from its group checkbox, and clears them again', async () => {
    env.plans = [plan({ id: 'a' }), plan({ id: 'b', productName: 'Desk lamp' }), plan({ id: 'c', productName: 'Other', supplierId: 's2', supplierName: 'Zeta' })];
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    const group = screen.getByRole('checkbox', { name: 'Select all items of Acme' });
    await user.click(group);
    expect(screen.getByRole('checkbox', { name: 'Select Widget' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Desk lamp' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Other' })).not.toBeChecked();
    expect(screen.getByText(/2 selected/)).toBeInTheDocument();
    await user.click(group);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('does not let a row without a supplier be selected', () => {
    env.plans = [plan({ supplierId: null, supplierName: null })];
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByRole('checkbox', { name: 'Select Widget' })).toBeDisabled();
  });

  it('warns when a quantity is under the supplier minimum or not a whole pack', async () => {
    env.plans = [plan({ id: 'a', minOrderQty: 50, orderMultiple: 1 }), plan({ id: 'b', productName: 'Desk lamp', orderMultiple: 12 })];
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    const widget = screen.getByLabelText('Quantity to order for Widget');
    await user.clear(widget);
    await user.type(widget, '20');
    expect(screen.getByText('Supplier minimum is 50')).toBeInTheDocument();
    expect(screen.getByText('Comes in packs of 12')).toBeInTheDocument();
  });

  it('treats an emptied quantity as 0', async () => {
    env.plans = [plan({ id: 'a' })];
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    const quantity = screen.getByLabelText('Quantity to order for Widget');
    await user.clear(quantity);
    expect(quantity).toHaveValue(0);
  });

  it('opens the plan of a clicked row', async () => {
    env.plans = [plan({ id: 'a' })];
    const onOpenPlan = vi.fn();
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={onOpenPlan} onOpenSettings={noop} />);
    await user.click(screen.getByRole('button', { name: 'Widget' }));
    expect(onOpenPlan).toHaveBeenCalledWith('a');
  });

  it('snoozes an item from the row menu and drops it from the selection', async () => {
    env.plans = [plan({ id: 'a' })];
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select Widget' }));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open row actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Snooze for 30 days' }));
    expect(env.dismiss).toHaveBeenCalledWith({ id: 'a', data: { until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/) } });
    await waitFor(() => expect(env.toast.success).toHaveBeenCalledWith('Snoozed for 30 days'));
    expect(screen.queryByText(/1 selected/)).not.toBeInTheDocument();
  });

  it('shows why a snooze failed, with a fallback message', async () => {
    env.plans = [plan({ id: 'a' })];
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    env.dismiss.mockRejectedValueOnce(new Error('Already ordered'));
    await user.click(screen.getByRole('button', { name: 'Open row actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Snooze for 7 days' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenLastCalledWith('Already ordered'));

    env.dismiss.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Open row actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Snooze for 7 days' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenLastCalledWith('Could not snooze this item'));
  });

  it('offers no snooze without the update permission', () => {
    env.permissions = new Set(['purchase_orders:create']);
    env.plans = [plan()];
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.queryByRole('button', { name: 'Open row actions' })).not.toBeInTheDocument();
  });

  it('clears the selection after orders were created and the result is closed', async () => {
    env.plans = [plan({ id: 'a' })];
    env.create.mockResolvedValue({ purchaseOrders: [{ id: 'po_1', poNumber: 'PO-1', supplierId: 's1', supplierName: 'Acme', warehouseId: 'w1', lineCount: 1, total: '250.00' }], skipped: [] });
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select Widget' }));
    await user.click(screen.getByRole('button', { name: /Create draft purchase orders/ }));
    await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Create orders' }));
    await screen.findByText('Draft orders created');
    await user.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: 'Select Widget' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Create draft purchase orders/ })).toBeDisabled();
  });
});

describe('ReorderTab loading, errors and filters', () => {
  it('shows a loader while loading', () => {
    env.loading = true;
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.queryByText('Nothing to reorder')).not.toBeInTheDocument();
  });

  it('shows the error with a retry, or a generic message', async () => {
    env.isError = true;
    env.error = new Error('Server down');
    const user = userEvent.setup();
    const { unmount } = render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByText('Server down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(env.refetch).toHaveBeenCalled();
    unmount();

    env.error = null;
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByText('Could not load the reorder list.')).toBeInTheDocument();
  });

  it('loads the next page on request', async () => {
    env.plans = [plan()];
    env.hasNextPage = true;
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(env.fetchNextPage).toHaveBeenCalled();
  });

  it('asks only for items that need reordering, and says no items match when a filter hides them all', async () => {
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(env.queryArgs).toHaveBeenLastCalledWith({ needsReorder: true, limit: 200 });
    await user.type(screen.getByLabelText('Search products…'), 'zzz');
    await waitFor(() => expect(env.queryArgs).toHaveBeenLastCalledWith({ needsReorder: true, limit: 200, search: 'zzz' }));
    expect(screen.getByText('No items match')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument();
  });

  it('opens the settings from the low-data banner', async () => {
    env.plans = [plan({ confidence: 'none' })];
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<ReorderTab onOpenPlan={noop} onOpenSettings={onOpenSettings} />);
    await user.click(screen.getByRole('button', { name: 'Import sales history' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
