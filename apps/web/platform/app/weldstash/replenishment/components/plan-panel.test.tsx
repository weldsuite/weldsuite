import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlanDemand, ReorderRule, ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const env = vi.hoisted(() => ({
  detail: undefined as unknown,
  demand: undefined as unknown,
  permissions: new Set<string>(),
  restore: vi.fn(),
  refetchDetail: vi.fn(),
  refetchDemand: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  usePlan: () => env.detail,
  usePlanDemand: () => env.demand,
  useRestorePlan: () => ({ mutateAsync: env.restore, isPending: false }),
}));
vi.mock('./demand-chart', () => ({ DemandChart: () => <div data-testid="demand-chart" /> }));
vi.mock('./rule-editor', () => ({
  RuleEditor: ({ canManage, rule }: { canManage: boolean; rule: ReorderRule | null }) => (
    <div data-testid="rule-editor">{`${canManage ? 'manage' : 'read'}:${rule ? rule.id : 'no-rule'}`}</div>
  ),
}));

import { PlanPanel } from './plan-panel';

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

function ready<T>(data: T): QueryState<T> {
  return { data, isLoading: false, isError: false, error: null, refetch: vi.fn() };
}

const noDemand: PlanDemand = { history: [], forecast: [] } as PlanDemand;

beforeEach(() => {
  env.permissions = new Set(['inventory:update', 'inventory:manage']);
  env.detail = ready({ plan: plan(), rule: null });
  env.demand = ready(noDemand);
  env.restore.mockReset().mockResolvedValue({});
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

describe('PlanPanel', () => {
  it('renders nothing while no plan is open', () => {
    env.detail = { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() };
    render(<PlanPanel planId={null} onClose={vi.fn()} />);
    expect(screen.queryByTestId('rule-editor')).not.toBeInTheDocument();
  });

  it('shows the item, the numbers behind the suggestion, the explanation, the chart and the rule', () => {
    env.detail = ready({ plan: plan({ variantName: 'Blue' }), rule: { id: 'rule_1' } as ReorderRule });
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);

    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText('W-1 · Blue · Main')).toBeInTheDocument();
    expect(screen.getByText('20 days')).toBeInTheDocument();
    expect(screen.getByText('7 days')).toBeInTheDocument();
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('Seasonal forecast')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByTestId('plan-explanation')).toHaveTextContent(/Reorder at 140/);
    expect(screen.getByTestId('demand-chart')).toBeInTheDocument();
    expect(screen.getByTestId('rule-editor')).toHaveTextContent('manage:rule_1');
  });

  it('flags urgency and overstock beside the numbers', () => {
    env.detail = ready({
      plan: plan({ onHand: 5, allocated: 5, stockoutDate: '2020-01-01', daysOfCover: '400' }),
      rule: null,
    });
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getAllByText('Out of stock').length).toBeGreaterThan(0);
    expect(screen.getByText('Overstock')).toBeInTheDocument();
  });

  it('shows dashes for numbers the plan does not have', () => {
    env.detail = ready({
      plan: plan({
        daysOfCover: null,
        stockoutDate: null,
        leadTimeDays: null,
        reviewPeriodDays: null,
        serviceLevel: null,
        safetyStock: null,
        reorderPoint: null,
        orderUpTo: null,
        supplierId: null,
        supplierName: null,
        unitCost: null,
        method: 'none',
        confidence: 'none',
      }),
      rule: null,
    });
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(8);
    expect(screen.getByText('No supplier')).toBeInTheDocument();
    expect(screen.getByText('No history')).toBeInTheDocument();
  });

  it('shows an unknown method as it came from the server', () => {
    env.detail = ready({ plan: plan({ method: 'future_method' as ReplenishmentPlan['method'] }), rule: null });
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('future_method')).toBeInTheDocument();
  });

  it('marks a plan in an Odoo-managed warehouse', () => {
    env.detail = ready({ plan: plan({ warehouseManagedByConnectionId: 'conn_odoo' }), rule: null });
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('Managed in Odoo')).toBeInTheDocument();
  });

  it('restores a dismissed item', async () => {
    env.detail = ready({ plan: plan({ reviewStatus: 'dismissed', dismissedUntil: '2026-12-01' }), rule: null });
    const user = userEvent.setup();
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText(/snoozed until/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(env.restore).toHaveBeenCalledWith('plan_1');
    expect(env.toast.success).toHaveBeenCalledWith('Item restored');
  });

  it('shows why a restore failed, with a fallback message', async () => {
    env.detail = ready({ plan: plan({ reviewStatus: 'dismissed' }), rule: null });
    const user = userEvent.setup();
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('This item was dismissed.')).toBeInTheDocument();

    env.restore.mockRejectedValueOnce(new Error('Gone'));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Gone');

    env.restore.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Could not restore this item');
  });

  it('does not offer restore without the update permission, and gives the rule editor read access', () => {
    env.permissions = new Set();
    env.detail = ready({ plan: plan({ reviewStatus: 'dismissed' }), rule: null });
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    expect(screen.getByTestId('rule-editor')).toHaveTextContent('read:no-rule');
  });

  it('says when an item is on a draft purchase order', () => {
    env.detail = ready({ plan: plan({ reviewStatus: 'ordered' }), rule: null });
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('This item is on a draft purchase order.')).toBeInTheDocument();
  });

  it('shows a spinner while the item loads, and an error with a retry when it fails', async () => {
    env.detail = { data: undefined, isLoading: true, isError: false, error: null, refetch: env.refetchDetail };
    const { rerender } = render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    env.detail = { data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch: env.refetchDetail };
    rerender(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(env.refetchDetail).toHaveBeenCalled();
  });

  it('shows a generic message when the item fails without one', () => {
    env.detail = { data: undefined, isLoading: false, isError: true, error: null, refetch: env.refetchDetail };
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('Could not load this item.')).toBeInTheDocument();
  });

  it('keeps the numbers and shows an error with a retry when only the demand fails', async () => {
    env.demand = { data: undefined, isLoading: false, isError: true, error: new Error('no demand'), refetch: env.refetchDemand };
    render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('no demand')).toBeInTheDocument();
    expect(screen.queryByTestId('demand-chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('plan-explanation')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(env.refetchDemand).toHaveBeenCalled();
  });

  it('shows a generic message when the demand fails without one, and a spinner while it loads', () => {
    env.demand = { data: undefined, isLoading: false, isError: true, error: null, refetch: env.refetchDemand };
    const { rerender } = render(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.getByText('Could not load the demand history.')).toBeInTheDocument();

    env.demand = { data: undefined, isLoading: true, isError: false, error: null, refetch: env.refetchDemand };
    rerender(<PlanPanel planId="plan_1" onClose={vi.fn()} />);
    expect(screen.queryByText('Could not load the demand history.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('demand-chart')).not.toBeInTheDocument();
  });
});
