import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceDiscount } from '@/hooks/queries/use-commerce-orders-queries';

interface StubColumn {
  id: string;
  render: (row: CommerceDiscount) => ReactNode;
}

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  open: vi.fn(),
  deleteDiscount: vi.fn(),
  createIntent: null as null | (() => void),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.open }),
  useObjectPanelUrlSync: () => undefined,
}));
vi.mock('@/hooks/use-create-intent', () => ({
  useCreateIntent: (fn: () => void) => {
    env.createIntent = fn;
  },
}));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useDeleteCommerceDiscount: () => ({ mutateAsync: env.deleteDiscount }),
}));
vi.mock('./discount-dialog', () => ({
  DiscountDialog: ({ discount }: { discount?: CommerceDiscount }) => <div role="dialog">{discount ? `editing ${discount.name}` : 'new discount'}</div>,
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
    items: CommerceDiscount[];
    columns: StubColumn[];
    onRowClick: (row: CommerceDiscount) => void;
    onEdit?: (row: CommerceDiscount) => void;
    onDelete?: (row: CommerceDiscount) => void;
    createButton?: { label: string; onClick: () => void };
    emptyState: { title: string };
    leftActionButtons: ReactNode;
  }) => (
    <div>
      <div data-testid="filter">{leftActionButtons}</div>
      {createButton && (
        <button type="button" onClick={createButton.onClick}>
          {createButton.label}
        </button>
      )}
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
              open {row.name}
            </button>
            {onEdit && (
              <button type="button" onClick={() => onEdit(row)}>
                edit {row.name}
              </button>
            )}
            {onDelete && (
              <button type="button" onClick={() => onDelete(row)}>
                delete {row.name}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  ),
}));

import { DiscountsList } from './discounts-list';

function discount(overrides: Partial<CommerceDiscount> = {}): CommerceDiscount {
  return {
    id: 'dsc_1',
    name: 'Spring sale',
    description: null,
    code: 'SPRING',
    type: 'percentage',
    value: '15.00',
    currency: null,
    maxDiscountAmount: null,
    appliesTo: 'all',
    productIds: [],
    variantIds: [],
    categoryIds: [],
    minimumSubtotal: null,
    minimumQuantity: null,
    usageLimit: 100,
    usageLimitPerCustomer: null,
    usageCount: 12,
    status: 'active',
    effectiveStatus: 'scheduled',
    startsAt: '2026-12-01T00:00:00.000Z',
    endsAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderList(overrides: Partial<Parameters<typeof DiscountsList>[0]> = {}) {
  const props = {
    discounts: [discount()],
    isLoading: false,
    search: '',
    onSearchChange: vi.fn(),
    effectiveStatus: undefined,
    onEffectiveStatusChange: vi.fn(),
    ...overrides,
  };
  render(<DiscountsList {...props} />);
  return { ...props, user: userEvent.setup() };
}

beforeEach(() => {
  env.allowed = new Set(['discounts:create', 'discounts:update', 'discounts:delete']);
  env.open.mockReset();
  env.deleteDiscount.mockReset();
  env.deleteDiscount.mockResolvedValue(undefined);
  env.createIntent = null;
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('DiscountsList', () => {
  it('shows the name, code, value, usage, validity and effective status', () => {
    renderList();
    expect(screen.getByTestId('dsc_1-name').textContent).toBe('Spring sale');
    expect(screen.getByTestId('dsc_1-code').textContent).toBe('SPRING');
    expect(screen.getByTestId('dsc_1-value').textContent).toBe('15%');
    expect(screen.getByTestId('dsc_1-usage').textContent).toBe('12 of 100');
    expect(screen.getByTestId('dsc_1-validity').textContent).toMatch(/^From /);
    expect(screen.getByTestId('dsc_1-status').textContent).toBe('Scheduled');
  });

  it('opens the discount panel on a row click', async () => {
    const { user } = renderList();
    await user.click(screen.getByRole('button', { name: 'open Spring sale' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'discount', id: 'dsc_1' });
  });

  it('opens the create dialog from New discount and from the create intent', async () => {
    const { user } = renderList();
    await user.click(screen.getByRole('button', { name: 'New discount' }));
    expect(screen.getByRole('dialog').textContent).toBe('new discount');
  });

  it('offers edit and delete only to a member who may', () => {
    env.allowed = new Set();
    renderList();
    for (const name of ['New discount', 'edit Spring sale', 'delete Spring sale']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('edits a discount in the dialog', async () => {
    const { user } = renderList();
    await user.click(screen.getByRole('button', { name: 'edit Spring sale' }));
    expect(screen.getByRole('dialog').textContent).toBe('editing Spring sale');
  });

  it('asks before deleting, then deletes and says so', async () => {
    const { user } = renderList();
    await user.click(screen.getByRole('button', { name: 'delete Spring sale' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this discount?' });
    expect(within(dialog).getByText(/"Spring sale" will be deleted/)).toBeTruthy();
    expect(env.deleteDiscount).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(env.deleteDiscount).toHaveBeenCalledWith('dsc_1');
    expect(toast.success).toHaveBeenCalledWith('Discount deleted');
  });

  it('shows a failed delete', async () => {
    env.deleteDiscount.mockRejectedValue(new Error('Still in use'));
    const { user } = renderList();
    await user.click(screen.getByRole('button', { name: 'delete Spring sale' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(toast.error).toHaveBeenCalledWith('Still in use');
  });

  it('puts the status filter in the toolbar', () => {
    renderList({ effectiveStatus: 'expired' });
    expect(within(screen.getByTestId('filter')).getByRole('combobox', { name: 'Status' }).textContent).toBe('Expired');
  });

  it('chooses its empty text by whether a search or filter is on', () => {
    const { unmount } = render(
      <DiscountsList discounts={[]} isLoading={false} search="" onSearchChange={vi.fn()} effectiveStatus={undefined} onEffectiveStatusChange={vi.fn()} />,
    );
    expect(screen.getByTestId('empty').textContent).toBe('No discount codes yet');
    unmount();
    render(
      <DiscountsList discounts={[]} isLoading={false} search="" onSearchChange={vi.fn()} effectiveStatus="active" onEffectiveStatusChange={vi.fn()} />,
    );
    expect(screen.getByTestId('empty').textContent).toBe('No discounts match your search or filters.');
  });
});
