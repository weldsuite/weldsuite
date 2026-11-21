import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';

const env = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  useCreatePurchaseOrdersFromPlans: () => ({ mutateAsync: env.create, isPending: false }),
}));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useSendPurchaseOrderToOdoo: () => ({ mutateAsync: env.send, isPending: false }),
}));

import { CreateOrdersDialog } from './create-orders-dialog';

function plan(overrides: Partial<ReplenishmentPlan>): ReplenishmentPlan {
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
    warehouseManagedByConnectionId: 'conn_odoo',
    supplierName: 'Acme',
    currency: 'EUR',
    unitCost: '2.5000',
    minOrderQty: null,
    orderMultiple: 1,
    ...overrides,
  };
}

beforeEach(() => {
  env.create.mockReset().mockResolvedValue({
    purchaseOrders: [{ id: 'po_1', poNumber: 'PO-0001', supplierId: 's1', supplierName: 'Acme', warehouseId: 'w1', lineCount: 1, total: '250.00' }],
    skipped: [{ planId: 'b', reason: 'already_ordered' }],
  });
  env.send.mockReset();
  env.push.mockReset();
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

const baseProps = { open: true, onOpenChange: vi.fn(), edits: {}, minimumOrderValues: {}, onCreated: vi.fn() };

function order(id: string, poNumber: string, warehouseId = 'w1') {
  return { id, poNumber, supplierId: 's1', supplierName: 'Acme', warehouseId, lineCount: 2, total: '100.00' };
}

describe('CreateOrdersDialog', () => {
  it('keeps the result readable after the Reorder list refetches without the ordered rows', async () => {
    const plans = [plan({ id: 'a' }), plan({ id: 'b', productName: 'Desk lamp', productSku: 'D-1' })];
    const props = { open: true, onOpenChange: vi.fn(), edits: {}, minimumOrderValues: {}, onCreated: vi.fn() };
    const user = userEvent.setup();
    const { rerender } = render(<CreateOrdersDialog {...props} plans={plans} />);

    await user.click(screen.getByRole('button', { name: 'Create orders' }));
    await screen.findByText('PO-0001');

    // The plans are `ordered` now, so the live list no longer has them.
    rerender(<CreateOrdersDialog {...props} plans={[]} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Send to Odoo' })).toBeInTheDocument();
    expect(within(dialog).getByText(/Desk lamp \(D-1\): already ordered/)).toBeInTheDocument();
    expect(within(dialog).getByText(/€\s?250\.00|250\.00\s?€/)).toBeInTheDocument();
  });
});

describe('CreateOrdersDialog warnings and creation', () => {
  it('lists the rows without a supplier, with quantity 0 and under a supplier minimum, and notes Odoo', () => {
    const plans = [
      plan({ id: 'a' }),
      plan({ id: 'b', productName: 'Loose bulb', supplierId: null, supplierName: null }),
      plan({ id: 'c', productName: 'Zero lamp', supplierId: 's2', supplierName: 'Zeta' }),
    ];
    render(
      <CreateOrdersDialog {...baseProps} plans={plans} edits={{ c: 0, a: 10 }} minimumOrderValues={{ s1: '400.00' }} />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('1 item has no supplier')).toBeInTheDocument();
    expect(within(dialog).getByText('Loose bulb')).toBeInTheDocument();
    expect(within(dialog).getByText('1 item has quantity 0')).toBeInTheDocument();
    expect(within(dialog).getByText('Acme has a minimum order value')).toBeInTheDocument();
    expect(within(dialog).getByText(/Some items are in a warehouse managed in Odoo/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 line will be added, worth/)).toBeInTheDocument();
  });

  it('cannot create anything from rows that all lack a supplier', () => {
    render(<CreateOrdersDialog {...baseProps} plans={[plan({ supplierId: null, supplierName: null })]} />);
    expect(screen.getByText('There is nothing to create from this selection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create orders' })).toBeDisabled();
  });

  it('sends only the quantities that were changed', async () => {
    const user = userEvent.setup();
    render(<CreateOrdersDialog {...baseProps} plans={[plan({ id: 'a' }), plan({ id: 'b' })]} edits={{ b: 7 }} />);
    await user.click(screen.getByRole('button', { name: 'Create orders' }));
    expect(env.create).toHaveBeenCalledWith({ planIds: ['a', 'b'], quantities: { b: 7 } });
  });

  it('shows the server message when creating fails, and a fallback without one', async () => {
    const user = userEvent.setup();
    render(<CreateOrdersDialog {...baseProps} plans={[plan({ id: 'a' })]} />);
    env.create.mockRejectedValueOnce(new Error('Supplier archived'));
    await user.click(screen.getByRole('button', { name: 'Create orders' }));
    expect(await screen.findByText('Supplier archived')).toBeInTheDocument();
    expect(screen.queryByText('PO-0001')).not.toBeInTheDocument();

    env.create.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Create orders' }));
    expect(await screen.findByText('Could not create the purchase orders')).toBeInTheDocument();
  });

  it('closes without creating anything and does not tell the caller to clear its selection', async () => {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<CreateOrdersDialog {...baseProps} onOpenChange={onOpenChange} onCreated={onCreated} plans={[plan({ id: 'a' })]} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('CreateOrdersDialog result', () => {
  async function created(result: unknown, plans = [plan({ id: 'a' })], extra: Partial<typeof baseProps> = {}) {
    env.create.mockResolvedValue(result);
    const user = userEvent.setup();
    const props = { ...baseProps, onOpenChange: vi.fn(), onCreated: vi.fn(), ...extra };
    render(<CreateOrdersDialog {...props} plans={plans} />);
    await user.click(screen.getByRole('button', { name: 'Create orders' }));
    await screen.findByText('Draft orders created');
    return { user, props };
  }

  it('sends one order to Odoo and shows the Odoo name it got', async () => {
    env.send.mockResolvedValue({ odoo: { name: 'P00042' } });
    const { user } = await created({ purchaseOrders: [order('po_1', 'PO-0001')], skipped: [] });
    expect(screen.queryByRole('button', { name: 'Send all to Odoo' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send to Odoo' }));
    expect(env.send).toHaveBeenCalledWith('po_1');
    expect(await screen.findByText('Sent as P00042')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to Odoo' })).not.toBeInTheDocument();
  });

  it('shows a toast when sending to Odoo fails, with a fallback message, and allows another try', async () => {
    const { user } = await created({ purchaseOrders: [order('po_1', 'PO-0001')], skipped: [] });
    env.send.mockRejectedValueOnce(new Error('Odoo refused'));
    await user.click(screen.getByRole('button', { name: 'Send to Odoo' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenLastCalledWith('Odoo refused'));
    env.send.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Send to Odoo' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenLastCalledWith('Could not send to Odoo'));
    expect(screen.getByRole('button', { name: 'Send to Odoo' })).toBeEnabled();
  });

  it('sends every order that is not sent yet with Send all', async () => {
    env.send.mockImplementation((id: string) => Promise.resolve({ odoo: { name: `S-${id}` } }));
    const { user } = await created({
      purchaseOrders: [order('po_1', 'PO-0001'), order('po_2', 'PO-0002'), order('po_3', 'PO-0003', 'w_other')],
      skipped: [],
    });
    // The third order is in a warehouse that is not managed in Odoo: no button for it.
    expect(screen.getAllByRole('button', { name: 'Send to Odoo' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Send all to Odoo' }));
    expect(await screen.findByText('Sent as S-po_2')).toBeInTheDocument();
    expect(env.send.mock.calls.map((c) => c[0])).toEqual(['po_1', 'po_2']);
    expect(screen.queryByRole('button', { name: 'Send all to Odoo' })).not.toBeInTheDocument();
  });

  it('opens an order from its number and the list from View purchase orders', async () => {
    const { user } = await created({ purchaseOrders: [order('po_1', 'PO-0001')], skipped: [] });
    await user.click(screen.getByRole('button', { name: 'PO-0001' }));
    expect(env.push).toHaveBeenLastCalledWith('/weldstash/purchase-orders/po_1');
    await user.click(screen.getByRole('button', { name: 'View purchase orders' }));
    expect(env.push).toHaveBeenLastCalledWith('/weldstash/purchase-orders');
  });

  it('names the skipped rows, by product and SKU, by name alone, or by id when unknown', async () => {
    await created(
      {
        purchaseOrders: [order('po_1', 'PO-0001')],
        skipped: [
          { planId: 'a', reason: 'no_supplier' },
          { planId: 'b', reason: 'zero_quantity' },
          { planId: 'gone', reason: 'not_found' },
        ],
      },
      [plan({ id: 'a' }), plan({ id: 'b', productName: 'Plain thing', productSku: null })],
    );
    expect(screen.getByText('3 items were skipped')).toBeInTheDocument();
    expect(screen.getByText('Widget (W-1): no supplier')).toBeInTheDocument();
    expect(screen.getByText('Plain thing: quantity is 0')).toBeInTheDocument();
    expect(screen.getByText('gone: not found')).toBeInTheDocument();
  });

  it('tells the caller to clear its selection only when the result is closed', async () => {
    const { user, props } = await created({ purchaseOrders: [order('po_1', 'PO-0001')], skipped: [] });
    expect(props.onCreated).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(props.onCreated).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
