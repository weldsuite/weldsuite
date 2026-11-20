import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashSuppliers: () => ({ data: { data: [{ id: 's1', name: 'Acme' }] } }),
  useWeldstashWarehouses: () => ({ data: { data: [{ id: 'w1', name: 'Main' }] } }),
}));

import { EMPTY_PLAN_FILTERS, PlanFilters, planFilterQuery, type PlanFilterState } from './plan-filters';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

describe('planFilterQuery', () => {
  it('sends only the filters that are set', () => {
    expect(planFilterQuery(EMPTY_PLAN_FILTERS, '')).toEqual({});
    expect(
      planFilterQuery(
        { search: 'ignored', supplierId: 's1', warehouseId: 'w1', urgency: 'review', confidence: 'low', status: 'open' },
        'lamp',
      ),
    ).toEqual({ search: 'lamp', supplierId: 's1', warehouseId: 'w1', urgency: 'review', confidence: 'low', status: 'open' });
  });
});

describe('PlanFilters', () => {
  async function pick(user: ReturnType<typeof userEvent.setup>, trigger: string, option: string) {
    await user.click(screen.getByRole('combobox', { name: trigger }));
    await user.click(await screen.findByRole('option', { name: option }));
  }

  it('reports the typed search text with the other filters kept', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<PlanFilters state={{ search: '', supplierId: 's1' }} onChange={onChange} />);
    await user.type(screen.getByLabelText('Search products…'), 'a');
    expect(onChange).toHaveBeenLastCalledWith({ search: 'a', supplierId: 's1' });
  });

  it('reports the supplier, warehouse, urgency and confidence that were picked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<PlanFilters state={EMPTY_PLAN_FILTERS} onChange={onChange} />);

    await pick(user, 'Supplier', 'Acme');
    expect(onChange).toHaveBeenLastCalledWith({ search: '', supplierId: 's1' });

    await pick(user, 'Warehouse', 'Main');
    expect(onChange).toHaveBeenLastCalledWith({ search: '', warehouseId: 'w1' });

    await pick(user, 'Urgency', 'Runs out within lead time');
    expect(onChange).toHaveBeenLastCalledWith({ search: '', urgency: 'lead_time' });

    await pick(user, 'Confidence', 'Low');
    expect(onChange).toHaveBeenLastCalledWith({ search: '', confidence: 'low' });
  });

  it('clears a filter by picking its "all" option', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const state: PlanFilterState = { search: '', supplierId: 's1' };
    render(<PlanFilters state={state} onChange={onChange} />);
    await pick(user, 'Supplier', 'All suppliers');
    expect(onChange).toHaveBeenLastCalledWith({ search: '', supplierId: undefined });
  });

  it('offers the review status only where asked for', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<PlanFilters state={EMPTY_PLAN_FILTERS} onChange={onChange} />);
    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();

    rerender(<PlanFilters state={EMPTY_PLAN_FILTERS} onChange={onChange} showStatus />);
    await pick(user, 'Status', 'Dismissed');
    expect(onChange).toHaveBeenLastCalledWith({ search: '', status: 'dismissed' });
  });
});
