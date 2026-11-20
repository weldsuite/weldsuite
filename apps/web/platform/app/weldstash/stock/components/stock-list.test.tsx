import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WeldstashStockRow } from '@weldsuite/core-api-client/schemas/weldstash';

interface StubColumn {
  id: string;
  render: (row: WeldstashStockRow) => ReactNode;
}

const env = vi.hoisted(() => ({
  warehouses: [] as { id: string; name: string; managedByConnectionId: string | null }[],
}));

vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: vi.fn() }),
  useObjectPanelUrlSync: () => undefined,
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashWarehouses: () => ({ data: { data: env.warehouses } }),
}));
vi.mock('./adjust-stock-dialog', () => ({ AdjustStockDialog: () => null }));
// The list shell is not under test: render the warehouse cell of each row it is given.
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: ({ items, columns }: { items: WeldstashStockRow[]; columns: StubColumn[] }) => {
    const warehouse = columns.find((c) => c.id === 'warehouse');
    return (
      <ul>
        {items.map((row) => (
          <li key={row.id} data-testid={`row-${row.id}`}>
            {warehouse?.render(row)}
          </li>
        ))}
      </ul>
    );
  },
}));

import { StockList } from './stock-list';

function row(id: string, warehouseId: string, warehouseName: string): WeldstashStockRow {
  return { id, productId: 'p1', warehouseId, warehouseName } as WeldstashStockRow;
}

const props = { isLoading: false, search: '', onSearchChange: vi.fn() };

beforeEach(() => {
  env.warehouses = [
    { id: 'w_odoo', name: 'Odoo warehouse', managedByConnectionId: 'conn_1' },
    { id: 'w_own', name: 'Own warehouse', managedByConnectionId: null },
  ];
});

describe('StockList', () => {
  it('marks only the rows in a warehouse managed in Odoo', () => {
    render(<StockList {...props} stock={[row('a', 'w_odoo', 'Odoo warehouse'), row('b', 'w_own', 'Own warehouse')]} />);
    expect(screen.getByTestId('row-a')).toHaveTextContent('Managed in Odoo');
    expect(screen.getByTestId('row-b')).not.toHaveTextContent('Managed in Odoo');
  });

  it('marks nothing while the warehouses have not loaded', () => {
    env.warehouses = [];
    render(<StockList {...props} stock={[row('a', 'w_odoo', 'Odoo warehouse')]} />);
    expect(screen.getByTestId('row-a')).not.toHaveTextContent('Managed in Odoo');
  });
});
