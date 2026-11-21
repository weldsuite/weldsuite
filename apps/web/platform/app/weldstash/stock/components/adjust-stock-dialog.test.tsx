import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useAdjustWeldstashStock: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWeldstashProducts: () => ({ data: { data: [{ id: 'p1', name: 'Widget', sku: 'W-1' }] } }),
  useWeldstashWarehouses: () => ({
    data: {
      data: [
        { id: 'w_odoo', name: 'Odoo warehouse', managedByConnectionId: 'conn_1' },
        { id: 'w_own', name: 'Own warehouse', managedByConnectionId: null },
      ],
    },
  }),
}));

import { AdjustStockDialog } from './adjust-stock-dialog';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

describe('AdjustStockDialog', () => {
  it('does not offer a warehouse managed in Odoo, since its stock is kept there', async () => {
    const user = userEvent.setup();
    render(<AdjustStockDialog open onOpenChange={vi.fn()} />);
    const triggers = screen.getAllByRole('combobox');
    // Product first, warehouse second.
    await user.click(triggers[1]);
    expect(await screen.findByRole('option', { name: 'Own warehouse' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Odoo warehouse' })).not.toBeInTheDocument();
  });
});
