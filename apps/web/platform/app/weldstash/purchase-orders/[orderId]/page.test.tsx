import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PurchaseOrder, PurchaseOrderLine } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  order: {} as Record<string, unknown>,
  lines: {} as Record<string, unknown>,
  receipts: {} as Record<string, unknown>,
  warehouse: undefined as Record<string, unknown> | undefined,
  connection: undefined as Record<string, unknown> | undefined,
  connectionId: [] as Array<string | null>,
  permissions: new Set<string>(),
  push: vi.fn(),
  refetch: vi.fn(),
  approve: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
  sendToOdoo: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: env.push }),
  useParams: () => ({ orderId: 'po_1' }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashWarehouse: () => ({ data: env.warehouse ? { data: env.warehouse } : undefined }),
  useWeldstashSuppliers: () => ({ data: { data: [] } }),
  useWeldstashWarehouses: () => ({ data: { data: [] } }),
  useWeldstashProducts: () => ({ data: { data: [] } }),
}));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useConnectorConnection: (id: string | null) => {
    env.connectionId.push(id);
    return { data: env.connection ? { data: env.connection } : undefined };
  },
}));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  usePurchaseOrder: () => env.order,
  usePurchaseOrderLines: () => env.lines,
  usePurchaseOrderReceipts: () => env.receipts,
  useApprovePurchaseOrder: () => ({ mutateAsync: env.approve, isPending: false }),
  useCancelPurchaseOrder: () => ({ mutateAsync: env.cancel, isPending: false }),
  useClosePurchaseOrder: () => ({ mutateAsync: env.close, isPending: false }),
  useDeletePurchaseOrder: () => ({ mutateAsync: env.remove, isPending: false }),
  useSendPurchaseOrderToOdoo: () => ({ mutateAsync: env.sendToOdoo, isPending: false }),
  useMarkPurchaseOrderOrdered: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReceivePurchaseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWarehouseLocations: () => ({ data: [] }),
  useProductTracking: () => ({ tracking: {}, isLoading: false }),
  useCreatePurchaseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePurchaseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreatePurchaseOrderLine: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePurchaseOrderLine: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeletePurchaseOrderLine: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import WeldStashPurchaseOrderPage from './page';

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
    itemCount: 1,
    totalQuantityOrdered: 10,
    totalQuantityReceived: 0,
    paymentTerms: 'Net 30',
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

function line(overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'poi_1',
    purchaseOrderId: 'po_1',
    productId: 'prod_1',
    variantId: null,
    sku: 'W-1',
    name: 'Widget',
    quantityOrdered: 10,
    quantityReceived: 0,
    quantityPending: 10,
    quantityRejected: 0,
    unitPrice: '2.50',
    discountPercent: '0.00',
    discountAmount: '0.00',
    taxPercent: '21.00',
    taxAmount: '5.25',
    total: '25.00',
    lastReceivedDate: null,
    notes: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function setOrder(overrides: Partial<PurchaseOrder> = {}) {
  env.order = { data: order(overrides), isLoading: false, isError: false, refetch: env.refetch };
}

const EDITOR = ['orders:update', 'orders:delete'];

function enableRust() {
  setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash'], unavailableFeatures: [] });
}

async function openMore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'More actions' }));
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.permissions = new Set(EDITOR);
  env.warehouse = undefined;
  env.connection = undefined;
  env.connectionId.length = 0;
  env.lines = { data: [line()], isLoading: false, isError: false, refetch: env.refetch };
  env.receipts = { data: [], isLoading: false, isError: false, refetch: env.refetch };
  setOrder();
  for (const fn of [env.push, env.refetch, env.approve, env.cancel, env.close, env.remove, env.sendToOdoo]) fn.mockReset().mockResolvedValue({});
  env.sendToOdoo.mockResolvedValue({ odoo: { id: 7, name: 'P00007' } });
  env.toast.success.mockClear();
  env.toast.error.mockClear();
  env.toast.message.mockClear();
});

afterEach(() => {
  setRuntimeConfig(null);
});

describe('purchase order page: loading and errors', () => {
  it('shows a loader while the order loads', () => {
    env.order = { data: undefined, isLoading: true, isError: false, refetch: env.refetch };
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.queryByText('PO-20261101-AB12')).not.toBeInTheDocument();
    expect(screen.queryByText('This purchase order could not be found.')).not.toBeInTheDocument();
  });

  it('shows the error and retries on request', async () => {
    env.order = { data: undefined, isLoading: false, isError: true, error: new Error('Server down'), refetch: env.refetch };
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.getByText('Server down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('says the order cannot be found when there is no order and no error text', () => {
    env.order = { data: undefined, isLoading: false, isError: false, refetch: env.refetch };
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.getByText('This purchase order could not be found.')).toBeInTheDocument();
  });

  it('shows a loader and then an error with a retry for the lines', async () => {
    env.lines = { data: undefined, isLoading: true, isError: false, refetch: env.refetch };
    const { unmount } = render(<WeldStashPurchaseOrderPage />);
    expect(screen.queryByText('Widget')).not.toBeInTheDocument();
    unmount();
    env.lines = { data: undefined, isLoading: false, isError: true, error: new Error('Lines down'), refetch: env.refetch };
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.getByText('Lines down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('falls back to a generic message when the lines error has none', () => {
    env.lines = { data: undefined, isLoading: false, isError: true, error: null, refetch: env.refetch };
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.getByText('Could not load the lines.')).toBeInTheDocument();
  });
});

describe('purchase order page: the order', () => {
  it('shows the header, details, lines and totals, and goes back to the list', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.getByText('PO-20261101-AB12')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Acme · Main')).toBeInTheDocument();
    expect(screen.getByText('Net 30')).toBeInTheDocument();
    expect(screen.getByText('Widget')).toBeInTheDocument();
    const totals = screen.getByTestId('po-totals');
    expect(within(totals).getByText('Subtotal')).toBeInTheDocument();
    expect(within(totals).getByText('Total')).toBeInTheDocument();
    expect(within(totals).queryByText('Shipping')).not.toBeInTheDocument();
    expect(within(totals).queryByText('Discount')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(env.push).toHaveBeenCalledWith('/weldstash/purchase-orders');
  });

  it('shows the shipping and discount rows only when they are above zero', () => {
    setOrder({ shippingTotal: '4.00', discountTotal: '1.00' });
    render(<WeldStashPurchaseOrderPage />);
    const totals = screen.getByTestId('po-totals');
    expect(within(totals).getByText('Shipping')).toBeInTheDocument();
    expect(within(totals).getByText('Discount')).toBeInTheDocument();
    expect(within(totals).getByText('-€1.00')).toBeInTheDocument();
  });

  it('shows the subtitle with only the names that exist', () => {
    setOrder({ warehouseName: null });
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.getAllByText('Acme')).toHaveLength(2);
    expect(screen.queryByText(/Acme ·/)).not.toBeInTheDocument();
  });
});

describe('purchase order page on Global (no runtime config)', () => {
  it('offers edit, delete and line changes, but no lifecycle actions or receipts', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add line' })).toBeInTheDocument();
    for (const name of ['Approve', 'Mark as ordered', 'Receive goods', 'Send to Odoo']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Receipts')).not.toBeInTheDocument();
    await openMore(user);
    expect(screen.queryByRole('menuitem', { name: 'Cancel order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Close order' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('does not look up the warehouse connection', () => {
    env.warehouse = { id: 'wh_1', managedByConnectionId: 'conn_1' };
    render(<WeldStashPurchaseOrderPage />);
    expect(env.connectionId.every((id) => id === null)).toBe(true);
  });

  it('opens the edit dialog with the status chooser', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit purchase order')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('deletes after confirming and returns to the list', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Purchase order PO-20261101-AB12 and its lines will be deleted.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(env.remove).toHaveBeenCalledWith('po_1'));
    expect(env.toast.success).toHaveBeenCalledWith('Purchase order deleted');
    expect(env.push).toHaveBeenCalledWith('/weldstash/purchase-orders');
  });

  it('shows the error and stays on the page when the delete fails', async () => {
    env.remove.mockRejectedValue(new Error('Has receipts'));
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Has receipts'));
    expect(env.push).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the delete error has none', async () => {
    env.remove.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not delete the purchase order'));
  });

  it('hides edit, delete and the menu without permission', () => {
    env.permissions = new Set();
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
  });
});

describe('purchase order page on a Kubernetes edition', () => {
  beforeEach(enableRust);

  it('approves a draft, and shows the failure when it is refused', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(env.approve).toHaveBeenCalledWith('po_1'));
    expect(env.toast.success).toHaveBeenCalledWith('Purchase order approved');

    env.approve.mockRejectedValue(new Error('Needs a line'));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Needs a line'));
  });

  it('falls back to a generic message when an action fails without one', async () => {
    env.approve.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('That did not work'));
  });

  it('cancels a draft after confirming', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cancel this purchase order?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(env.cancel).toHaveBeenCalledWith('po_1'));
    expect(env.toast.success).toHaveBeenCalledWith('Purchase order cancelled');
  });

  it('shows the failure when the cancel is refused', async () => {
    env.cancel.mockRejectedValue(new Error('Goods already received'));
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Cancel order' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Goods already received'));
  });

  it('marks an approved order as ordered through the dialog, and offers receive and edit but no approve', async () => {
    setOrder({ status: 'approved' });
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receive goods' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Record that this order was sent to the supplier.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens the receive dialog on an ordered order', async () => {
    setOrder({ status: 'ordered' });
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await user.click(screen.getByRole('button', { name: 'Receive goods' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Receive goods on PO-20261101-AB12')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes a partly received order after confirming, and offers no cancel', async () => {
    setOrder({ status: 'partial', totalQuantityReceived: 4 });
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await openMore(user);
    expect(screen.queryByRole('menuitem', { name: 'Cancel order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Close order' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Close this purchase order?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close order' }));
    await waitFor(() => expect(env.close).toHaveBeenCalledWith('po_1'));
    expect(env.toast.success).toHaveBeenCalledWith('Purchase order closed');
  });

  it('offers no actions on a closed order', () => {
    setOrder({ status: 'closed', totalQuantityReceived: 10 });
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive goods' })).not.toBeInTheDocument();
  });

  it('shows a separator and delete after cancel on a draft, and delete alone on a cancelled order', async () => {
    setOrder({ status: 'cancelled' });
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await openMore(user);
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Cancel order' })).not.toBeInTheDocument();
  });

  it('shows the Receipts tab and its content', async () => {
    const user = userEvent.setup();
    render(<WeldStashPurchaseOrderPage />);
    await user.click(screen.getByText('Receipts'));
    expect(await screen.findByText('Nothing received yet')).toBeInTheDocument();
    await user.click(screen.getByText('Lines'));
    expect(await screen.findByText('Widget')).toBeInTheDocument();
  });

  it('hides lifecycle actions without the update permission', () => {
    env.permissions = new Set();
    render(<WeldStashPurchaseOrderPage />);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  describe('with a warehouse managed in Odoo', () => {
    beforeEach(() => {
      env.warehouse = { id: 'wh_1', managedByConnectionId: 'conn_1' };
      env.connection = { id: 'conn_1', provider: 'odoo' };
    });

    it('shows the badge and notice and sends the order to Odoo after confirming', async () => {
      const user = userEvent.setup();
      render(<WeldStashPurchaseOrderPage />);
      expect(screen.getByText('Managed in Odoo')).toBeInTheDocument();
      expect(screen.getByText(/You can send this order to Odoo as a request for quotation/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Send to Odoo' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Send to Odoo' }));
      await waitFor(() => expect(env.sendToOdoo).toHaveBeenCalledWith('po_1'));
      expect(env.toast.message).toHaveBeenCalledWith('Created P00007 in Odoo');
      expect(env.toast.success).toHaveBeenCalledWith('Sent to Odoo');
    });

    it('shows the failure when sending to Odoo fails', async () => {
      env.sendToOdoo.mockRejectedValue(new Error('Odoo unreachable'));
      const user = userEvent.setup();
      render(<WeldStashPurchaseOrderPage />);
      await user.click(screen.getByRole('button', { name: 'Send to Odoo' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send to Odoo' }));
      await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Odoo unreachable'));
      expect(env.toast.success).not.toHaveBeenCalled();
    });

    it('does not treat a non-Odoo connection as managed in Odoo', () => {
      env.connection = { id: 'conn_1', provider: 'shopify' };
      render(<WeldStashPurchaseOrderPage />);
      expect(screen.queryByText('Managed in Odoo')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send to Odoo' })).not.toBeInTheDocument();
    });
  });

  describe('an order already sent to Odoo', () => {
    it('shows the Odoo reference and offers no changes', () => {
      setOrder({ status: 'approved', metadata: { odoo: { id: 7, name: 'P00007' } } });
      render(<WeldStashPurchaseOrderPage />);
      expect(screen.getByText('Managed in Odoo')).toBeInTheDocument();
      expect(screen.getByText('This order is managed in Odoo as P00007. Confirm and receive it there.')).toBeInTheDocument();
      for (const name of ['Edit', 'Receive goods', 'Mark as ordered', 'Send to Odoo', 'More actions']) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
    });

    it('uses the notice without a name when Odoo gave none', () => {
      setOrder({ metadata: { odoo: {} } });
      render(<WeldStashPurchaseOrderPage />);
      expect(screen.getByText('This order is managed in Odoo. Confirm and receive it there.')).toBeInTheDocument();
    });
  });
});
