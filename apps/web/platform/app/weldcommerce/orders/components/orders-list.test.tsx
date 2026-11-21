import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrderSummary } from '@/hooks/queries/use-commerce-orders-queries';

interface StubColumn {
  id: string;
  render: (row: OrderSummary) => ReactNode;
}

const env = vi.hoisted(() => ({
  allowed: new Set<string>(['orders:create']),
  open: vi.fn(),
  push: vi.fn(),
  createIntent: null as null | (() => void),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.open }),
  useObjectPanelUrlSync: () => undefined,
}));
vi.mock('@/hooks/use-create-intent', () => ({
  useCreateIntent: (fn: () => void) => {
    env.createIntent = fn;
  },
}));
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: ({
    items,
    columns,
    onRowClick,
    onEdit,
    onDelete,
    createButton,
    emptyState,
    leftActionButtons,
  }: {
    items: OrderSummary[];
    columns: StubColumn[];
    onRowClick: (row: OrderSummary) => void;
    onEdit?: unknown;
    onDelete?: unknown;
    createButton?: { label: string; onClick: () => void };
    emptyState: { title: string; action?: unknown };
    leftActionButtons: ReactNode;
  }) => (
    <div>
      <div data-testid="filters">{leftActionButtons}</div>
      {createButton && (
        <button type="button" onClick={createButton.onClick}>
          {createButton.label}
        </button>
      )}
      <p data-testid="menu">{onEdit || onDelete ? 'menu' : 'no menu'}</p>
      {items.length === 0 && <p data-testid="empty">{emptyState.title}</p>}
      <ul>
        {items.map((row) => (
          <li key={row.id}>
            {columns.map((column) => (
              <span key={column.id} data-testid={`${row.id}-${column.id}`}>
                {column.render(row)}
              </span>
            ))}
            <button type="button" onClick={() => onRowClick(row)}>
              open {row.orderNumber}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ),
}));

import { OrdersList } from './orders-list';

function row(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: 'ord_1',
    orderNumber: 'WC-1001',
    status: 'confirmed',
    paymentStatus: 'pending',
    fulfillmentStatus: 'unfulfilled',
    approvalStatus: 'not_required',
    source: 'woocommerce',
    channelId: null,
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.com',
    personId: null,
    companyId: 'comp_1',
    companyName: 'Acme',
    currency: 'EUR',
    total: '125.00',
    itemCount: 2,
    totalQuantity: 5,
    placedAt: '2026-11-20T10:00:00.000Z',
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...overrides,
  };
}

function renderList(overrides: Partial<Parameters<typeof OrdersList>[0]> = {}) {
  const props = {
    orders: [row()],
    isLoading: false,
    search: '',
    onSearchChange: vi.fn(),
    filters: {},
    onFilterChange: vi.fn(),
    onClearFilters: vi.fn(),
    ...overrides,
  };
  render(<OrdersList {...props} />);
  return { ...props, user: userEvent.setup() };
}

beforeEach(() => {
  env.allowed = new Set(['orders:create']);
  env.open.mockReset();
  env.push.mockReset();
  env.createIntent = null;
});

describe('OrdersList', () => {
  it('shows the order, the buyer, the statuses, the total and the source', () => {
    renderList();
    expect(screen.getByTestId('ord_1-order').textContent).toBe('WC-1001');
    // The company first, with the person under it.
    expect(screen.getByTestId('ord_1-customer').textContent).toBe('AcmeAda Lovelace');
    expect(screen.getByTestId('ord_1-status').textContent).toBe('Confirmed');
    expect(screen.getByTestId('ord_1-payment').textContent).toBe('Unpaid');
    expect(screen.getByTestId('ord_1-fulfilment').textContent).toBe('Unfulfilled');
    expect(screen.getByTestId('ord_1-source').textContent).toBe('WooCommerce');
    expect(screen.getByTestId('ord_1-items').textContent).toBe('2 items');
    expect(screen.getByTestId('ord_1-total').textContent).toContain('125.00');
  });

  it('falls back from the company to the person to the email, and from an unknown buyer to a dash', () => {
    renderList({
      orders: [
        row({ id: 'a', companyName: null }),
        row({ id: 'b', companyName: null, customerName: null }),
        row({ id: 'c', companyName: null, customerName: null, customerEmail: null }),
      ],
    });
    expect(screen.getByTestId('a-customer').textContent).toBe('Ada Lovelaceada@example.com');
    expect(screen.getByTestId('b-customer').textContent).toBe('ada@example.com');
    expect(screen.getByTestId('c-customer').textContent).toBe('—');
  });

  it('opens the order panel on a row click', async () => {
    const { user } = renderList();
    await user.click(screen.getByRole('button', { name: 'open WC-1001' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'order', id: 'ord_1' });
  });

  it('has no row menu: orders are cancelled and edited in their panel', () => {
    renderList();
    expect(screen.getByTestId('menu').textContent).toBe('no menu');
  });

  it('opens the order form from New order and from the create intent, for a member who may create', async () => {
    const { user } = renderList();
    await user.click(screen.getByRole('button', { name: 'New order' }));
    expect(env.push).toHaveBeenCalledWith('/weldcommerce/orders/new');
    env.createIntent?.();
    expect(env.push).toHaveBeenCalledTimes(2);
  });

  it('hides New order from a member who may not create orders', () => {
    env.allowed = new Set();
    renderList();
    expect(screen.queryByRole('button', { name: 'New order' })).toBeNull();
    env.createIntent?.();
    expect(env.push).not.toHaveBeenCalled();
  });

  it('shows the filters in the toolbar, wired to the page', async () => {
    const { user, onClearFilters } = renderList({ filters: { status: 'pending' } });
    const filters = within(screen.getByTestId('filters'));
    expect(filters.getByLabelText('Filter orders')).toBeTruthy();
    await user.click(filters.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalled();
  });

  it('says "no orders yet" for an empty list, and "no match" when a search or filter is on', () => {
    const { rerender } = render(
      <OrdersList
        orders={[]}
        isLoading={false}
        search=""
        onSearchChange={vi.fn()}
        filters={{}}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );
    expect(screen.getByTestId('empty').textContent).toBe('No orders yet');
    rerender(
      <OrdersList
        orders={[]}
        isLoading={false}
        search=""
        onSearchChange={vi.fn()}
        filters={{ source: 'manual' }}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );
    expect(screen.getByTestId('empty').textContent).toBe('No orders match your search or filters.');
  });
});
