import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReorderRule, ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';

const env = vi.hoisted(() => ({
  upsert: vi.fn(),
  remove: vi.fn(),
  suppliers: [] as { id: string; supplierName: string; isPreferred: boolean }[],
  suppliersArgs: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  useUpsertReorderRule: () => ({ mutateAsync: env.upsert, isPending: false }),
  useDeleteReorderRule: () => ({ mutateAsync: env.remove, isPending: false }),
}));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useProductSuppliers: (args: unknown) => {
    env.suppliersArgs(args);
    return { data: env.suppliers };
  },
}));

import { RuleEditor } from './rule-editor';

const plan = { id: 'plan_1', productId: 'p1', variantId: null, warehouseId: 'w1' } as ReplenishmentPlan;

function rule(overrides: Partial<ReorderRule> = {}): ReorderRule {
  return {
    id: 'rule_1',
    productId: 'p1',
    variantId: null,
    warehouseId: 'w1',
    method: 'min_max',
    minQty: 10,
    maxQty: 50,
    serviceLevel: null,
    reviewPeriodDays: null,
    leadTimeDaysOverride: null,
    productSupplierId: null,
    updatedAt: '2026-11-18T10:00:00Z',
    ...overrides,
  } as ReorderRule;
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.upsert.mockReset().mockResolvedValue({});
  env.remove.mockReset().mockResolvedValue(undefined);
  env.suppliers = [
    { id: 'ps1', supplierName: 'Acme', isPreferred: true },
    { id: 'ps2', supplierName: 'Zeta', isPreferred: false },
  ];
  env.suppliersArgs.mockReset();
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

async function pick(user: ReturnType<typeof userEvent.setup>, trigger: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: trigger }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('RuleEditor', () => {
  it('looks up the suppliers of the plan item', () => {
    render(<RuleEditor plan={plan} rule={null} canManage />);
    expect(env.suppliersArgs).toHaveBeenCalledWith({ productId: 'p1', variantId: 'none' });
  });

  it('saves the default rule with the overrides left empty', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={null} canManage />);
    expect(screen.getByText('The forecast sets the reorder point.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(env.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'p1', warehouseId: 'w1', method: 'auto', serviceLevel: null, productSupplierId: null }),
    );
    expect(env.toast.success).toHaveBeenCalledWith('Rule saved');
    expect(screen.queryByRole('button', { name: 'Back to automatic' })).not.toBeInTheDocument();
  });

  it('saves a min/max rule with a service level override and a chosen supplier', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={null} canManage />);
    await pick(user, 'Method', 'Min / max');
    expect(screen.getByText(/Order up to the maximum when stock drops/)).toBeInTheDocument();
    // The service level only applies to the automatic method.
    expect(screen.queryByLabelText('Service level %')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Minimum'), '10');
    await user.type(screen.getByLabelText('Maximum'), '40');
    await user.type(screen.getByLabelText('Lead time (days)'), '12');
    await pick(user, 'Supplier', 'Zeta');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(env.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'min_max', minQty: 10, maxQty: 40, leadTimeDaysOverride: 12, productSupplierId: 'ps2' }),
    );
  });

  it('sends the service level of the automatic method as a fraction', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={null} canManage />);
    await user.type(screen.getByLabelText('Service level %'), '97.5');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(env.upsert).toHaveBeenCalledWith(expect.objectContaining({ method: 'auto', serviceLevel: 0.975 }));
  });

  it('marks the preferred supplier and can go back to the preferred one', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={rule({ method: 'auto', productSupplierId: 'ps2' })} canManage />);
    expect(screen.getByRole('combobox', { name: 'Supplier' })).toHaveTextContent('Zeta');
    await user.click(screen.getByRole('combobox', { name: 'Supplier' }));
    expect(await screen.findByRole('option', { name: 'Acme (preferred)' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Preferred supplier' }));
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(env.upsert).toHaveBeenCalledWith(expect.objectContaining({ productSupplierId: null }));
  });

  it('refuses a minimum above the maximum and does not call the API', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={rule({ minQty: 60, maxQty: 50 })} canManage />);
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(await screen.findByText(/with the minimum not above the maximum/)).toBeInTheDocument();
    expect(env.upsert).not.toHaveBeenCalled();
  });

  it('refuses text where a number is expected', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={null} canManage />);
    await user.type(screen.getByLabelText('Review period (days)'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(await screen.findByText('Check this value')).toBeInTheDocument();
    expect(env.upsert).not.toHaveBeenCalled();
  });

  it('shows the server message when saving fails, and a fallback without one', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={null} canManage />);
    env.upsert.mockRejectedValueOnce(new Error('Conflict'));
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Conflict');
    env.upsert.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Could not save the rule');
  });

  it('removes the rule to go back to automatic', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={rule()} canManage />);
    expect(screen.getByLabelText('Minimum')).toHaveValue('10');
    await user.click(screen.getByRole('button', { name: 'Back to automatic' }));
    expect(env.remove).toHaveBeenCalledWith('rule_1');
    expect(env.toast.success).toHaveBeenCalledWith('Rule removed');
  });

  it('shows why removing the rule failed', async () => {
    const user = userEvent.setup();
    render(<RuleEditor plan={plan} rule={rule()} canManage />);
    env.remove.mockRejectedValueOnce(new Error('Locked'));
    await user.click(screen.getByRole('button', { name: 'Back to automatic' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Locked');
    env.remove.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Back to automatic' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Could not save the rule');
  });

  it('hides the extra fields for a rule that is off', () => {
    render(<RuleEditor plan={plan} rule={rule({ method: 'off' })} canManage />);
    expect(screen.getByText('Never suggest orders for this item.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Lead time (days)')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Supplier' })).not.toBeInTheDocument();
  });

  it('loads the form of another item when the rule changes', () => {
    const { rerender } = render(<RuleEditor plan={plan} rule={rule()} canManage />);
    expect(screen.getByLabelText('Minimum')).toHaveValue('10');
    rerender(<RuleEditor plan={{ ...plan, id: 'plan_2' }} rule={rule({ id: 'rule_2', minQty: 3, maxQty: 9 })} canManage />);
    expect(screen.getByLabelText('Minimum')).toHaveValue('3');
  });

  it('is read-only without the manage permission', () => {
    render(<RuleEditor plan={plan} rule={rule()} canManage={false} />);
    expect(screen.getByText('You can see this rule but not change it.')).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save rule' })).not.toBeInTheDocument();
  });
});
