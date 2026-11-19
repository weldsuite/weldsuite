import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PurchaseOrder } from '@weldsuite/app-api-client/schemas/purchase-orders';

const env = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useCreatePurchaseOrder: () => ({ mutateAsync: env.create, isPending: false }),
  useUpdatePurchaseOrder: () => ({ mutateAsync: env.update, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashSuppliers: () => ({
    data: {
      data: [
        { id: 'sup_1', name: 'Acme', currency: 'USD' },
        { id: 'sup_2', name: 'Zeta', currency: null },
      ],
    },
  }),
  useWeldstashWarehouses: () => ({ data: { data: [{ id: 'wh_1', name: 'Main' }] } }),
}));

import { generatePoNumber, PoFormDialog } from './po-form-dialog';

function order(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po_1',
    poNumber: 'PO-20261101-AB12',
    supplierId: 'sup_gone',
    supplierName: 'Old Supplier BV',
    warehouseId: 'wh_gone',
    warehouseName: 'Old Warehouse',
    status: 'draft',
    orderDate: null,
    expectedDate: '2026-12-01T00:00:00.000Z',
    receivedDate: null,
    currency: 'EUR',
    subtotal: '0.00',
    taxTotal: '0.00',
    shippingTotal: '5.00',
    discountTotal: '0.00',
    total: '5.00',
    itemCount: 0,
    totalQuantityOrdered: 0,
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

function renderDialog(props: { order?: PurchaseOrder; chooseStatus?: boolean; onSaved?: (id: string) => void } = {}) {
  const onOpenChange = vi.fn();
  render(<PoFormDialog open onOpenChange={onOpenChange} {...props} />);
  return onOpenChange;
}

async function pick(user: ReturnType<typeof userEvent.setup>, trigger: string | RegExp, option: string) {
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
  env.create.mockReset().mockResolvedValue({ id: 'po_new' });
  env.update.mockReset().mockResolvedValue({});
  env.toast.success.mockClear();
  env.toast.error.mockClear();
});

describe('generatePoNumber', () => {
  it('builds PO-YYYYMMDD-XXXX from the date', () => {
    expect(generatePoNumber(new Date('2026-11-19T10:00:00Z'))).toMatch(/^PO-20261119-[A-Z0-9]{4}$/);
  });

  it('uses today without an argument', () => {
    expect(generatePoNumber()).toMatch(/^PO-\d{8}-[A-Z0-9]{4}$/);
  });
});

describe('PoFormDialog creating', () => {
  it('creates an order with the supplier name, its currency and no warehouse', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onOpenChange = renderDialog({ onSaved });
    expect(screen.getByText('New purchase order', { selector: 'h2, [data-slot="dialog-title"]' })).toBeInTheDocument();
    await pick(user, 'Supplier', 'Acme');
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create).toHaveBeenCalledWith({
      supplierId: 'sup_1',
      supplierName: 'Acme',
      warehouseId: null,
      warehouseName: null,
      expectedDate: null,
      currency: 'USD',
      paymentTerms: null,
      shippingTotal: 0,
      discountTotal: 0,
      supplierNotes: null,
      internalNotes: null,
      poNumber: expect.stringMatching(/^PO-\d{8}-[A-Z0-9]{4}$/),
    });
    expect(env.toast.success).toHaveBeenCalledWith('Purchase order created');
    expect(onSaved).toHaveBeenCalledWith('po_new');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends the chosen warehouse, dates, amounts and notes, with the currency upper-cased', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pick(user, 'Supplier', 'Zeta');
    await pick(user, 'Deliver to warehouse', 'Main');
    await user.type(screen.getByLabelText('Expected date'), '2026-12-24');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'gbp');
    await user.type(screen.getByLabelText('Payment terms'), 'Net 14');
    await user.type(screen.getByLabelText('Shipping'), '7.5');
    await user.type(screen.getByLabelText('Discount'), '2');
    await user.type(screen.getByLabelText('Notes for the supplier'), 'Call first');
    await user.type(screen.getByLabelText('Internal notes'), 'Rush');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create.mock.calls[0][0]).toMatchObject({
      supplierId: 'sup_2',
      supplierName: 'Zeta',
      warehouseId: 'wh_1',
      warehouseName: 'Main',
      expectedDate: '2026-12-24T00:00:00.000Z',
      currency: 'GBP',
      paymentTerms: 'Net 14',
      shippingTotal: 7.5,
      discountTotal: 2,
      supplierNotes: 'Call first',
      internalNotes: 'Rush',
    });
  });

  it('keeps the default currency when the chosen supplier has none', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pick(user, 'Supplier', 'Zeta');
    expect(screen.getByLabelText('Currency')).toHaveValue('EUR');
  });

  it('asks for a supplier and a 3-letter currency, and sends nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'EU');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText('Choose a supplier', { selector: '[data-slot="form-message"], p' })).toBeInTheDocument();
    expect(screen.getByText('Use a 3-letter currency code')).toBeInTheDocument();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('shows the error and stays open when the create fails', async () => {
    env.create.mockRejectedValue(new Error('Duplicate PO number'));
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onOpenChange = renderDialog({ onSaved });
    await pick(user, 'Supplier', 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Duplicate PO number'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error has none', async () => {
    env.create.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    renderDialog();
    await pick(user, 'Supplier', 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not save the purchase order'));
  });

  it('closes on cancel', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('PoFormDialog editing', () => {
  it('prefills the order and keeps the saved supplier and warehouse names when they are unchanged and not in the loaded list', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onOpenChange = renderDialog({ order: order(), onSaved });
    expect(screen.getByText('Edit purchase order', { selector: 'h2, [data-slot="dialog-title"]' })).toBeInTheDocument();
    expect(screen.getByLabelText('Expected date')).toHaveValue('2026-12-01');
    expect(screen.getByLabelText('Payment terms')).toHaveValue('Net 30');
    expect(screen.getByLabelText('Shipping')).toHaveValue(5);
    await user.type(screen.getByLabelText('Internal notes'), 'Checked');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    const call = env.update.mock.calls[0][0];
    expect(call.id).toBe('po_1');
    expect(call.data).toMatchObject({
      supplierId: 'sup_gone',
      supplierName: 'Old Supplier BV',
      warehouseId: 'wh_gone',
      warehouseName: 'Old Warehouse',
      currency: 'EUR',
      internalNotes: 'Checked',
    });
    // Without chooseStatus the status is not part of the update.
    expect(call.data).not.toHaveProperty('status');
    expect(env.create).not.toHaveBeenCalled();
    expect(env.toast.success).toHaveBeenCalledWith('Purchase order updated');
    expect(onSaved).toHaveBeenCalledWith('po_1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('takes the name of a newly picked supplier and warehouse, and keeps the order currency', async () => {
    const user = userEvent.setup();
    renderDialog({ order: order() });
    await pick(user, 'Supplier', 'Acme');
    await pick(user, 'Deliver to warehouse', 'Main');
    expect(screen.getByLabelText('Currency')).toHaveValue('EUR');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update.mock.calls[0][0].data).toMatchObject({
      supplierId: 'sup_1',
      supplierName: 'Acme',
      warehouseId: 'wh_1',
      warehouseName: 'Main',
    });
  });

  it('clears the warehouse name when the warehouse is removed', async () => {
    const user = userEvent.setup();
    renderDialog({ order: order() });
    await pick(user, 'Deliver to warehouse', 'No warehouse yet');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update.mock.calls[0][0].data).toMatchObject({ warehouseId: null, warehouseName: null });
  });

  it('lets the status be chosen when chooseStatus is on (Global)', async () => {
    const user = userEvent.setup();
    renderDialog({ order: order({ supplierId: 'sup_1', supplierName: 'Acme' }), chooseStatus: true });
    await pick(user, 'Status', 'Received');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update.mock.calls[0][0].data.status).toBe('received');
  });

  it('shows the error and stays open when the update fails', async () => {
    env.update.mockRejectedValue(new Error('Order is managed in Odoo'));
    const user = userEvent.setup();
    const onOpenChange = renderDialog({ order: order() });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Order is managed in Odoo'));
    expect(env.toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
