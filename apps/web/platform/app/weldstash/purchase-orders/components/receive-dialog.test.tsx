import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PurchaseOrderLine } from '@weldsuite/app-api-client/schemas/purchase-orders';

const env = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  tracking: {} as Record<string, { id: string; trackLots: boolean; trackExpiry: boolean }>,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useReceivePurchaseOrder: () => ({ mutateAsync: env.mutateAsync, isPending: false }),
  useWarehouseLocations: () => ({ data: [{ id: 'loc_1', code: 'A-01', name: 'Aisle A' }] }),
  useProductTracking: () => ({ tracking: env.tracking, isLoading: false }),
}));

import { ReceiveDialog } from './receive-dialog';

function line(overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'poi_1',
    purchaseOrderId: 'po_1',
    productId: 'prod_1',
    variantId: null,
    sku: 'W-1',
    name: 'Widget',
    quantityOrdered: 10,
    quantityReceived: 4,
    quantityPending: 6,
    quantityRejected: 1,
    unitPrice: '2.50',
    discountPercent: '0.00',
    discountAmount: '0.00',
    taxPercent: '21.00',
    taxAmount: '0.00',
    total: '25.00',
    lastReceivedDate: null,
    notes: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

const order = { id: 'po_1', poNumber: 'PO-20261101-AB12', warehouseId: 'wh_1', warehouseName: 'Main' };

function renderDialog(lines: PurchaseOrderLine[] = [line()]) {
  return render(<ReceiveDialog open onOpenChange={vi.fn()} order={order} lines={lines} />);
}

beforeEach(() => {
  env.mutateAsync.mockReset().mockResolvedValue({});
  env.tracking = {};
  env.toast.success.mockClear();
});

describe('ReceiveDialog', () => {
  it('prefills each line with what remains to be received', () => {
    renderDialog();
    expect(screen.getByText('Receive goods on PO-20261101-AB12')).toBeInTheDocument();
    expect(screen.getByLabelText('Received')).toHaveValue('5');
    expect(screen.getByLabelText('Rejected')).toHaveValue('0');
    expect(screen.getByText('5 still to receive')).toBeInTheDocument();
  });

  it('shows lot and expiry fields only for a product that tracks them', () => {
    const { unmount } = renderDialog();
    expect(screen.queryByLabelText('Lot number')).not.toBeInTheDocument();
    unmount();
    env.tracking = { prod_1: { id: 'prod_1', trackLots: true, trackExpiry: true } };
    renderDialog();
    expect(screen.getByLabelText('Lot number')).toBeInTheDocument();
    expect(screen.getByLabelText('Expiry date')).toBeInTheDocument();
  });

  it('refuses more than remains and sends nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(screen.getByLabelText('Received'));
    await user.type(screen.getByLabelText('Received'), '9');
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    expect(await screen.findByText(/more than what is still to receive/)).toBeInTheDocument();
    expect(env.mutateAsync).not.toHaveBeenCalled();
  });

  it('asks for a lot number on a lot-tracked product', async () => {
    env.tracking = { prod_1: { id: 'prod_1', trackLots: true, trackExpiry: false } };
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    expect(await screen.findByText(/enter a lot number/)).toBeInTheDocument();
    expect(env.mutateAsync).not.toHaveBeenCalled();
  });

  it('submits the lines with an idempotency key and keeps the key when the same submit is retried', async () => {
    env.mutateAsync.mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderDialog();
    await user.clear(screen.getByLabelText('Received'));
    await user.type(screen.getByLabelText('Received'), '3');
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    expect(await screen.findByText('Network down')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Receive' }));
    await waitFor(() => expect(env.mutateAsync).toHaveBeenCalledTimes(2));

    const [first, second] = env.mutateAsync.mock.calls.map((call) => call[0]);
    expect(first.id).toBe('po_1');
    expect(first.data.lines).toEqual([{ itemId: 'poi_1', quantity: 3 }]);
    expect(first.data.idempotencyKey).toMatch(/\S{8,}/);
    // A retry of the unchanged submit must reuse the key, or stock could post twice.
    expect(second.data.idempotencyKey).toBe(first.data.idempotencyKey);
    expect(env.toast.success).toHaveBeenCalledWith('Goods received');
  });

  it('uses a new key once the user changes something after a failure', async () => {
    env.mutateAsync.mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    await screen.findByText('Network down');
    await user.clear(screen.getByLabelText('Received'));
    await user.type(screen.getByLabelText('Received'), '2');
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    await waitFor(() => expect(env.mutateAsync).toHaveBeenCalledTimes(2));
    const [first, second] = env.mutateAsync.mock.calls.map((call) => call[0]);
    expect(second.data.idempotencyKey).not.toBe(first.data.idempotencyKey);
  });

  it('says there is nothing to receive when every line is complete', () => {
    renderDialog([line({ quantityReceived: 10, quantityRejected: 0 })]);
    expect(screen.getByText('Everything on this order has been received.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receive' })).toBeDisabled();
  });
});
