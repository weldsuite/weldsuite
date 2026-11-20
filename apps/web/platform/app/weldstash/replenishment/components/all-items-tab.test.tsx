import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';

interface Page {
  data: ReplenishmentPlan[];
  pagination: { hasMore: boolean; cursor: string | null; totalCount: number };
}

const env = vi.hoisted(() => ({
  pages: [] as unknown[],
  loading: false,
  isError: false,
  error: null as Error | null,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  queryArgs: vi.fn(),
  restore: vi.fn(),
  permissions: new Set<string>(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  useInfinitePlans: (query: unknown) => {
    env.queryArgs(query);
    return {
      data: env.loading || env.isError ? undefined : { pages: env.pages },
      isLoading: env.loading,
      isError: env.isError,
      error: env.error,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: env.isFetchingNextPage,
      fetchNextPage: env.fetchNextPage,
      refetch: env.refetch,
    };
  },
  useRestorePlan: () => ({ mutateAsync: env.restore, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashSuppliers: () => ({ data: { data: [{ id: 's1', name: 'Acme' }] } }),
  useWeldstashWarehouses: () => ({ data: { data: [{ id: 'w1', name: 'Main' }] } }),
}));

import { AllItemsTab, sortPlans } from './all-items-tab';

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

function page(plans: ReplenishmentPlan[], hasMore = false): Page {
  return { data: plans, pagination: { hasMore, cursor: hasMore ? 'next' : null, totalCount: plans.length } };
}

const noop = () => undefined;

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.pages = [page([])];
  env.loading = false;
  env.isError = false;
  env.error = null;
  env.hasNextPage = false;
  env.isFetchingNextPage = false;
  env.fetchNextPage.mockReset();
  env.refetch.mockReset();
  env.queryArgs.mockReset();
  env.restore.mockReset().mockResolvedValue({});
  env.permissions = new Set(['inventory:update']);
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

describe('sortPlans', () => {
  const a = plan({ id: 'a', productName: 'Alpha', stockoutDate: '2026-12-01', daysOfCover: '10', suggestedQty: 5 });
  const b = plan({ id: 'b', productName: 'Beta', stockoutDate: null, daysOfCover: null, suggestedQty: 50 });
  const c = plan({ id: 'c', productName: 'Charlie', stockoutDate: '2026-11-20', daysOfCover: '200', suggestedQty: 20 });
  const ids = (sort: Parameters<typeof sortPlans>[1]) => sortPlans([a, b, c], sort).map((p) => p.id);

  it('puts what runs out first on top, items that never run out last', () => {
    expect(ids('runsOut')).toEqual(['c', 'a', 'b']);
  });

  it('puts the most days of cover first and missing cover last', () => {
    expect(ids('cover')).toEqual(['c', 'a', 'b']);
  });

  it('orders by suggestion size and by name, without changing the input', () => {
    const input = [a, b, c];
    expect(sortPlans(input, 'suggested').map((p) => p.id)).toEqual(['b', 'c', 'a']);
    expect(sortPlans([c, b, a], 'name').map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(input).toEqual([a, b, c]);
  });
});

describe('AllItemsTab', () => {
  it('shows a loader while the plans load', () => {
    env.loading = true;
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.queryByText('No items')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no items', () => {
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByText('No items')).toBeInTheDocument();
  });

  it('shows the error with a retry', async () => {
    env.isError = true;
    env.error = new Error('Server down');
    const user = userEvent.setup();
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByText('Server down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('shows a generic error message when the server gave none', () => {
    env.isError = true;
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByText('Could not load the items.')).toBeInTheDocument();
  });

  it('lists every item with its numbers, status, Odoo mark and overstock', () => {
    env.pages = [
      page([
        plan({ id: 'a', productName: 'Desk lamp', productSku: 'D-1', variantName: 'Blue', daysOfCover: '400', reviewStatus: 'open' }),
        plan({ id: 'b', productName: 'Bulb', productSku: null, supplierName: null, suggestedValue: null, reviewStatus: 'ordered', warehouseManagedByConnectionId: 'conn_odoo' }),
        plan({ id: 'c', productName: 'Cable', reviewStatus: 'dismissed' }),
        plan({ id: 'd', productName: 'Plug', reviewStatus: 'none' }),
      ]),
    ];
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByText('Desk lamp')).toBeInTheDocument();
    expect(screen.getByText('D-1')).toBeInTheDocument();
    expect(screen.getByText(/Blue/)).toBeInTheDocument();
    expect(screen.getByText('Overstock')).toBeInTheDocument();
    expect(screen.getByText('To reorder')).toBeInTheDocument();
    expect(screen.getByText('Ordered')).toBeInTheDocument();
    expect(screen.getByText('Dismissed')).toBeInTheDocument();
    expect(screen.getByText('Nothing to order')).toBeInTheDocument();
    expect(screen.getByText('Managed in Odoo')).toBeInTheDocument();
    // Available: 50 on hand - 5 reserved.
    expect(screen.getAllByText('45').length).toBeGreaterThan(0);
  });

  it('shows an unknown review status as the server sent it', () => {
    env.pages = [page([plan({ reviewStatus: 'paused' as ReplenishmentPlan['reviewStatus'] })])];
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('opens the plan of a clicked row', async () => {
    env.pages = [page([plan({ id: 'a', productName: 'Desk lamp' })])];
    const onOpenPlan = vi.fn();
    const user = userEvent.setup();
    render(<AllItemsTab onOpenPlan={onOpenPlan} onOpenSettings={noop} />);
    await user.click(screen.getByRole('button', { name: 'Desk lamp' }));
    expect(onOpenPlan).toHaveBeenCalledWith('a');
  });

  it('re-sorts the loaded rows from the sort menu', async () => {
    env.pages = [
      page([
        plan({ id: 'a', productName: 'Alpha', stockoutDate: '2026-12-01' }),
        plan({ id: 'b', productName: 'Beta', stockoutDate: '2026-11-20' }),
      ]),
    ];
    const user = userEvent.setup();
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    const order = () => (document.body.textContent ?? '').indexOf('Alpha') < (document.body.textContent ?? '').indexOf('Beta');
    expect(order()).toBe(false);
    await user.click(screen.getByRole('combobox', { name: 'Sort by' }));
    await user.click(await screen.findByRole('option', { name: 'Name' }));
    expect(order()).toBe(true);
  });

  it('points at the CSV import when some items have little history', async () => {
    env.pages = [page([plan({ confidence: 'low' }), plan({ id: 'b', confidence: 'none' }), plan({ id: 'c' })])];
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={onOpenSettings} />);
    expect(screen.getByText(/2 items have little or no sales history/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import sales history' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('restores a dismissed item from its row menu', async () => {
    env.pages = [page([plan({ id: 'c', productName: 'Cable', reviewStatus: 'dismissed' })])];
    const user = userEvent.setup();
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    await user.click(screen.getByRole('button', { name: 'Open row actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    expect(env.restore).toHaveBeenCalledWith('c');
    expect(env.toast.success).toHaveBeenCalledWith('Item restored');
  });

  it('shows why a restore failed, with a fallback message', async () => {
    env.pages = [page([plan({ id: 'c', productName: 'Cable', reviewStatus: 'dismissed' })])];
    const user = userEvent.setup();
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    env.restore.mockRejectedValueOnce(new Error('Already restored'));
    await user.click(screen.getByRole('button', { name: 'Open row actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Already restored');

    env.restore.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Open row actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Could not restore this item');
  });

  it('offers no row actions without the update permission, and none for items that are not dismissed', () => {
    env.permissions = new Set();
    env.pages = [page([plan({ reviewStatus: 'dismissed' })])];
    const { unmount } = render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.queryByRole('button', { name: 'Open row actions' })).not.toBeInTheDocument();
    unmount();

    env.permissions = new Set(['inventory:update']);
    env.pages = [page([plan({ reviewStatus: 'open' })])];
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(screen.queryByRole('menuitem', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('loads the next page by itself so the sort covers every item', () => {
    env.pages = [page([plan()], true)];
    env.hasNextPage = true;
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(env.fetchNextPage).toHaveBeenCalled();
  });

  it('waits for a page in flight and shows a spinner meanwhile', () => {
    env.pages = [page([plan()], true)];
    env.hasNextPage = true;
    env.isFetchingNextPage = true;
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(env.fetchNextPage).not.toHaveBeenCalled();
  });

  it('stops loading pages at 2,000 items', () => {
    const many = Array.from({ length: 2000 }, (_, i) => plan({ id: `p${i}`, productName: `Item ${i}` }));
    env.pages = [page(many, true)];
    env.hasNextPage = true;
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(env.fetchNextPage).not.toHaveBeenCalled();
  });

  it('queries with the filters, the search after a pause, and the review status', async () => {
    const user = userEvent.setup();
    render(<AllItemsTab onOpenPlan={noop} onOpenSettings={noop} />);
    expect(env.queryArgs).toHaveBeenLastCalledWith({ limit: 200 });

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Dismissed' }));
    expect(env.queryArgs).toHaveBeenLastCalledWith({ limit: 200, status: 'dismissed' });

    await user.type(screen.getByLabelText('Search products…'), 'lamp');
    await waitFor(() => expect(env.queryArgs).toHaveBeenLastCalledWith({ limit: 200, status: 'dismissed', search: 'lamp' }));
    expect(within(document.body).getByLabelText('Search products…')).toHaveValue('lamp');
  });
});
