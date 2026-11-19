import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PurchaseOrder } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  list: {} as Record<string, unknown>,
  filters: [] as unknown[],
  permissions: new Set<string>(),
  push: vi.fn(),
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useInfinitePurchaseOrders: (filters: unknown) => {
    env.filters.push(filters);
    return env.list;
  },
  useDeletePurchaseOrder: () => ({ mutateAsync: env.remove, isPending: false }),
  useCreatePurchaseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePurchaseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashSuppliers: () => ({ data: { data: [{ id: 'sup_1', name: 'Acme' }] } }),
  useWeldstashWarehouses: () => ({
    data: {
      data: [
        { id: 'wh_1', name: 'Main', managedByConnectionId: null },
        { id: 'wh_2', name: 'Odoo hub', managedByConnectionId: 'conn_1' },
      ],
    },
  }),
}));

import WeldStashPurchaseOrdersPage from './page';

function order(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po_1',
    poNumber: 'PO-20261101-AB12',
    supplierId: 'sup_1',
    supplierName: 'Acme',
    warehouseId: 'wh_1',
    warehouseName: 'Main',
    status: 'draft',
    orderDate: null,
    expectedDate: '2026-12-01T00:00:00.000Z',
    receivedDate: null,
    currency: 'EUR',
    subtotal: '25.00',
    taxTotal: '5.25',
    shippingTotal: '0.00',
    discountTotal: '0.00',
    total: '30.25',
    itemCount: 3,
    totalQuantityOrdered: 10,
    totalQuantityReceived: 0,
    paymentTerms: null,
    supplierNotes: null,
    internalNotes: null,
    approvedBy: null,
    approvedAt: null,
    createdBy: null,
    metadata: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function setList(orders: PurchaseOrder[], extra: Record<string, unknown> = {}) {
  env.list = {
    data: { pages: [{ data: orders }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: env.fetchNextPage,
    refetch: env.refetch,
    ...extra,
  };
}

const ALL = ['orders:create', 'orders:update', 'orders:delete'];

async function pickFilter(user: ReturnType<typeof userEvent.setup>, trigger: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: trigger }));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.permissions = new Set(ALL);
  env.filters.length = 0;
  for (const fn of [env.push, env.refetch, env.fetchNextPage, env.remove]) fn.mockReset().mockResolvedValue({});
  env.toast.success.mockClear();
  env.toast.error.mockClear();
  setList([order()]);
});

afterEach(() => {
  setRuntimeConfig(null);
});

describe('purchase orders list', () => {
  it('lists the orders with supplier, warehouse, status, expected date, line count and total', () => {
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByText('PO-20261101-AB12')).toBeInTheDocument();
    expect(screen.getByText('Acme', { selector: 'td, div' })).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('€30.25')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('uses the warehouse list for the name and badges a warehouse managed in Odoo', () => {
    setList([order({ warehouseId: 'wh_2', warehouseName: null }), order({ id: 'po_2', poNumber: 'PO-2', warehouseId: null, warehouseName: null, supplierName: null, itemCount: null })]);
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByText('Odoo hub')).toBeInTheDocument();
    expect(screen.getAllByText('Managed in Odoo')).toHaveLength(1);
  });

  it('shows a loader while loading and nothing else', () => {
    setList([], { data: undefined, isLoading: true });
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.queryByText('No purchase orders yet')).not.toBeInTheDocument();
  });

  it('shows the error and retries on request', async () => {
    setList([], { data: undefined, isError: true, error: new Error('Server down') });
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByText('Server down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('falls back to a generic error message', () => {
    setList([], { data: undefined, isError: true, error: null });
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByText('Could not load purchase orders.')).toBeInTheDocument();
  });

  it('opens an order when its row is clicked', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    await user.click(screen.getByRole('button', { name: 'PO-20261101-AB12' }));
    expect(env.push).toHaveBeenCalledWith('/weldstash/purchase-orders/po_1');
  });

  it('invites the first order when there are none, and creates one from the empty state', async () => {
    setList([]);
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByText('No purchase orders yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'New purchase order' }).at(-1) as HTMLElement);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('says there is nothing without offering to create when the user cannot create', () => {
    env.permissions = new Set();
    setList([]);
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByText('There are no purchase orders yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New purchase order' })).not.toBeInTheDocument();
  });

  it('says no orders match when filters are on and nothing is found', async () => {
    setList([]);
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    await pickFilter(user, 'Status', 'Approved');
    expect(await screen.findByText('No purchase orders match these filters.')).toBeInTheDocument();
  });

  it('opens the create dialog from the toolbar and goes to the new order when saved', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    await user.click(screen.getByRole('button', { name: 'New purchase order' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New purchase order', { selector: 'h2, [data-slot="dialog-title"]' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('filters by status, supplier and warehouse, and searches after typing pauses', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    expect(env.filters.at(-1)).toEqual({ limit: 50 });
    await pickFilter(user, 'Status', 'Approved');
    await pickFilter(user, 'Supplier', 'Acme');
    await pickFilter(user, 'Warehouse', 'Main');
    await user.type(screen.getByLabelText('Search by PO number…'), 'AB12');
    await waitFor(() =>
      expect(env.filters.at(-1)).toEqual({ limit: 50, search: 'AB12', status: 'approved', supplierId: 'sup_1', warehouseId: 'wh_1' }),
    );
    await pickFilter(user, 'Status', 'All statuses');
    await waitFor(() => expect(env.filters.at(-1)).not.toHaveProperty('status'));
  });

  it('loads more orders on request, and disables the button while loading', async () => {
    setList([order()], { hasNextPage: true });
    const user = userEvent.setup();
    const { unmount } = render(<WeldStashPurchaseOrdersPage />);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(env.fetchNextPage).toHaveBeenCalled();
    unmount();
    setList([order()], { hasNextPage: true, isFetchingNextPage: true });
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
  });

  it('treats a page without data as empty', () => {
    env.list = { ...env.list, data: { pages: [{}] } };
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByText('No purchase orders yet')).toBeInTheDocument();
  });
});

describe('purchase orders list row delete', () => {
  async function openDelete(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText('Open row actions'));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    return screen.findByRole('dialog');
  }

  it('deletes a draft after confirming', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    const dialog = await openDelete(user);
    expect(within(dialog).getByText('Purchase order PO-20261101-AB12 and its lines will be deleted.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(env.remove).toHaveBeenCalledWith('po_1'));
    expect(env.toast.success).toHaveBeenCalledWith('Purchase order deleted');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the error when the delete fails', async () => {
    env.remove.mockRejectedValue(new Error('Has receipts'));
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Has receipts'));
    expect(env.toast.success).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the delete error has none', async () => {
    env.remove.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrdersPage />);
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not delete the purchase order'));
  });

  it('offers no delete without the permission', () => {
    env.permissions = new Set(['orders:create', 'orders:update']);
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.queryByLabelText('Open row actions')).not.toBeInTheDocument();
  });

  it('offers delete on any status on Global, but only on draft, pending or cancelled on a Kubernetes edition', () => {
    setList([order({ status: 'ordered' })]);
    const { unmount } = render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByLabelText('Open row actions')).toBeInTheDocument();
    unmount();

    setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash'], unavailableFeatures: [] });
    const { unmount: unmountRust } = render(<WeldStashPurchaseOrdersPage />);
    expect(screen.queryByLabelText('Open row actions')).not.toBeInTheDocument();
    unmountRust();

    setList([order({ status: 'cancelled' })]);
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.getByLabelText('Open row actions')).toBeInTheDocument();
  });

  it('offers no delete on an order sent to Odoo', () => {
    setList([order({ metadata: { odoo: { name: 'P1' } } })]);
    render(<WeldStashPurchaseOrdersPage />);
    expect(screen.queryByLabelText('Open row actions')).not.toBeInTheDocument();
  });
});
