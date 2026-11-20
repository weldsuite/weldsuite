import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PurchaseOrderLine } from '@weldsuite/app-api-client/schemas/purchase-orders';

const env = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  productParams: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useCreatePurchaseOrderLine: () => ({ mutateAsync: env.create, isPending: false }),
  useUpdatePurchaseOrderLine: () => ({ mutateAsync: env.update, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashProducts: (params: unknown) => {
    env.productParams.push(params);
    return {
      data: {
        data: [
          { id: 'prod_1', name: 'Widget', sku: 'W-1', costPrice: 2.345 },
          { id: 'prod_2', name: 'Gadget', sku: null, costPrice: null },
        ],
      },
    };
  },
}));

import { PoLineDialog } from './po-line-dialog';

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
    discountPercent: '10.00',
    discountAmount: '0.00',
    taxPercent: '21.00',
    taxAmount: '0.00',
    total: '25.00',
    lastReceivedDate: null,
    notes: 'Handle with care',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function renderDialog(props: { line?: PurchaseOrderLine } = {}) {
  const onOpenChange = vi.fn();
  render(<PoLineDialog open onOpenChange={onOpenChange} orderId="po_1" currency="EUR" {...props} />);
  return onOpenChange;
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.create.mockReset().mockResolvedValue({});
  env.update.mockReset().mockResolvedValue({});
  env.productParams.length = 0;
  env.toast.success.mockClear();
  env.toast.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PoLineDialog', () => {
  it('adds a custom line and closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    expect(screen.getByText('Add line', { selector: '[data-slot="dialog-title"], h2' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Description'), 'Freight');
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '3');
    await user.clear(screen.getByLabelText('Unit price'));
    await user.type(screen.getByLabelText('Unit price'), '12');
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create).toHaveBeenCalledWith({
      productId: null,
      name: 'Freight',
      sku: null,
      quantityOrdered: 3,
      unitPrice: 12,
      discountPercent: 0,
      taxPercent: 0,
      notes: null,
    });
    expect(env.toast.success).toHaveBeenCalledWith('Line added');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('fills description, SKU and price from a picked product', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'Product' }));
    await user.click(await screen.findByRole('option', { name: 'Widget (W-1)' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Widget');
    expect(screen.getByLabelText('SKU')).toHaveValue('W-1');
    expect(screen.getByLabelText('Unit price')).toHaveValue(2.35);
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create.mock.calls[0][0]).toMatchObject({ productId: 'prod_1', name: 'Widget', sku: 'W-1', unitPrice: 2.35 });
  });

  it('keeps the typed price when the product has no cost, and picking custom again changes nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(screen.getByLabelText('Unit price'));
    await user.type(screen.getByLabelText('Unit price'), '9');
    await user.click(screen.getByRole('combobox', { name: 'Product' }));
    await user.click(await screen.findByRole('option', { name: 'Gadget' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Gadget');
    expect(screen.getByLabelText('SKU')).toHaveValue('');
    expect(screen.getByLabelText('Unit price')).toHaveValue(9);
    await user.click(screen.getByRole('combobox', { name: 'Product' }));
    await user.click(await screen.findByRole('option', { name: 'Custom line (no product)' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Gadget');
  });

  it('searches products after the typing pauses', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Search products…'), 'wid');
    await waitFor(() => expect(env.productParams.at(-1)).toEqual({ limit: 25, search: 'wid' }));
  });

  it('refuses an empty description and a zero quantity, and sends nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(screen.getByLabelText('Quantity'));
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    expect(await screen.findByText('Enter a description')).toBeInTheDocument();
    expect(screen.getByText('Enter a whole number of 1 or more')).toBeInTheDocument();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('shows the error and stays open when adding fails', async () => {
    env.create.mockRejectedValue(new Error('Order is locked'));
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    await user.type(screen.getByLabelText('Description'), 'Freight');
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Order is locked'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error has none', async () => {
    env.create.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Description'), 'Freight');
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not save the line'));
  });

  it('edits a line with its values prefilled, without the product picker', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog({ line: line() });
    expect(screen.queryByRole('combobox', { name: 'Product' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('Widget');
    expect(screen.getByLabelText('Quantity')).toHaveValue(10);
    expect(screen.getByLabelText('Discount %')).toHaveValue(10);
    expect(screen.getByLabelText('Notes')).toHaveValue('Handle with care');
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '12');
    await user.click(screen.getByRole('button', { name: 'Save line' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update).toHaveBeenCalledWith({
      itemId: 'poi_1',
      data: {
        productId: 'prod_1',
        name: 'Widget',
        sku: 'W-1',
        quantityOrdered: 12,
        unitPrice: 2.5,
        discountPercent: 10,
        taxPercent: 21,
        notes: 'Handle with care',
      },
    });
    expect(env.create).not.toHaveBeenCalled();
    expect(env.toast.success).toHaveBeenCalledWith('Line updated');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('previews the line total as the amounts change', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '4');
    await user.clear(screen.getByLabelText('Unit price'));
    await user.type(screen.getByLabelText('Unit price'), '10');
    expect(screen.getByText(/Line total/)).toHaveTextContent('€40.00');
  });

  it('closes on cancel', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
