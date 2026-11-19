import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';

const env = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
});

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
