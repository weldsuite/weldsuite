import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PurchaseOrderLine } from '@weldsuite/app-api-client/schemas/purchase-orders';

const env = vi.hoisted(() => ({
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useDeletePurchaseOrderLine: () => ({ mutateAsync: env.remove, isPending: false }),
  useCreatePurchaseOrderLine: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePurchaseOrderLine: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashProducts: () => ({ data: { data: [] } }),
}));

import { PoLinesTable } from './po-lines-table';

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

function renderTable(lines: PurchaseOrderLine[], editable: boolean) {
  render(<PoLinesTable orderId="po_1" currency="EUR" lines={lines} editable={editable} />);
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.remove.mockReset().mockResolvedValue({});
  env.toast.success.mockClear();
  env.toast.error.mockClear();
});

describe('PoLinesTable', () => {
  it('shows each line with its quantities, remaining to receive, price, tax and total', () => {
    renderTable([line()], false);
    const row = screen.getByText('Widget').closest('div.group') as HTMLElement;
    expect(within(row).getByText('W-1')).toBeInTheDocument();
    expect(within(row).getByText('€2.50')).toBeInTheDocument();
    expect(within(row).getByText('21%')).toBeInTheDocument();
    expect(within(row).getByText('€25.00')).toBeInTheDocument();
    // ordered 10, received 4, rejected 1, 5 remaining
    expect(Array.from(row.children).map((cell) => cell.textContent)).toEqual(
      expect.arrayContaining(['10', '4', '1', '5']),
    );
  });

  it('is read-only when not editable: no add button, no row actions, plain empty message', () => {
    renderTable([], false);
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Open row actions')).not.toBeInTheDocument();
    expect(screen.getByText('This order has no lines.')).toBeInTheDocument();
  });

  it('invites the first line when editable and empty, and opens the add dialog', async () => {
    const user = userEvent.setup();
    renderTable([], true);
    expect(screen.getByText('No lines yet. Add the products you want to order.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens the edit dialog from the row actions', async () => {
    const user = userEvent.setup();
    renderTable([line()], true);
    await user.click(screen.getByLabelText('Open row actions'));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit line' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Description')).toHaveValue('Widget');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('deletes a line after confirming', async () => {
    const user = userEvent.setup();
    renderTable([line()], true);
    await user.click(screen.getByLabelText('Open row actions'));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete line' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Widget will be removed from the order.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete line' }));
    await waitFor(() => expect(env.remove).toHaveBeenCalledWith('poi_1'));
    expect(env.toast.success).toHaveBeenCalledWith('Line deleted');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the error when the delete fails, and closes the confirmation', async () => {
    env.remove.mockRejectedValue(new Error('Order is locked'));
    const user = userEvent.setup();
    renderTable([line()], true);
    await user.click(screen.getByLabelText('Open row actions'));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete line' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete line' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Order is locked'));
    expect(env.toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('falls back to a generic message when the delete error has none', async () => {
    env.remove.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    renderTable([line()], true);
    await user.click(screen.getByLabelText('Open row actions'));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete line' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete line' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not delete the line'));
  });
});
