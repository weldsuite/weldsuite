import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';

const env = vi.hoisted(() => ({
  plans: [] as unknown[],
  loading: false,
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
  useInfinitePlans: () => ({
    data: { pages: [{ data: env.plans, pagination: { hasMore: false, cursor: null, totalCount: env.plans.length } }] },
    isLoading: env.loading,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
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
  env.permissions = new Set(['orders:create', 'inventory:update']);
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
