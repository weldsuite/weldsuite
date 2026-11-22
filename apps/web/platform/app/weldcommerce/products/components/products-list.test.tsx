import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceProduct } from '@/hooks/queries/use-commerce-queries';

interface StubColumn {
  id: string;
  render: (row: CommerceProduct) => ReactNode;
}

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  open: vi.fn(),
  deleteProduct: vi.fn(),
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
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useDeleteWeldstashProduct: () => ({ mutateAsync: env.deleteProduct }),
}));
vi.mock('@/app/weldstash/products/components/product-dialog', () => ({
  ProductDialog: ({ product }: { product?: CommerceProduct }) => (
    <div role="dialog">{product ? `editing ${product.name}` : 'new product'}</div>
  ),
}));
// The list shell is not under test: render each row's cells and its actions.
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: ({
    items,
    columns,
    onRowClick,
    onEdit,
    onDelete,
    createButton,
    emptyState,
  }: {
    items: CommerceProduct[];
    columns: StubColumn[];
    onRowClick: (row: CommerceProduct) => void;
    onEdit?: (row: CommerceProduct) => void;
    onDelete?: (row: CommerceProduct) => void;
    createButton?: { label: string; onClick: () => void };
    emptyState: { title: string };
  }) => (
    <div>
      {createButton && (
        <button type="button" onClick={createButton.onClick}>
          {createButton.label}
        </button>
      )}
      {items.length === 0 && <p>{emptyState.title}</p>}
      <ul>
        {items.map((row) => (
          <li key={row.id} data-testid={`row-${row.id}`}>
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

import { ProductsList } from './products-list';

function product(overrides: Partial<CommerceProduct> = {}): CommerceProduct {
  return {
    id: 'prod_1',
    name: 'Linen shirt',
    sku: 'SHIRT-1',
    price: 40,
    currency: 'EUR',
    status: 'active',
    brand: 'Weld',
    inventoryQuantity: 7,
    variantCount: 6,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

const props = { isLoading: false, search: '', onSearchChange: vi.fn() };

beforeEach(() => {
  env.allowed = new Set(['products:create', 'products:update', 'products:delete']);
  env.open.mockReset();
  env.deleteProduct.mockReset();
  env.createIntent = null;
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('WeldCommerce ProductsList', () => {
  it('shows the selling columns of each product', () => {
    render(
      <ProductsList
        {...props}
        products={[
          product(),
          product({ id: 'prod_2', name: 'Gift card', sku: null, variantCount: 0, status: 'draft', brand: null, featuredImageUrl: 'https://img/x.png' }),
        ]}
      />,
    );
    expect(screen.getByTestId('prod_1-name')).toHaveTextContent('Linen shirt');
    expect(screen.getByTestId('prod_1-sku')).toHaveTextContent('SHIRT-1');
    expect(screen.getByTestId('prod_1-price')).toHaveTextContent('40.00');
    expect(screen.getByTestId('prod_1-variants')).toHaveTextContent('6');
    expect(screen.getByTestId('prod_1-stock')).toHaveTextContent('7');
    expect(screen.getByTestId('prod_1-brand')).toHaveTextContent('Weld');
    expect(screen.getByTestId('prod_1-status')).toHaveTextContent('Active');
    expect(screen.getByTestId('prod_2-sku')).toHaveTextContent('—');
    expect(screen.getByTestId('prod_2-variants')).toHaveTextContent('—');
    expect(screen.getByTestId('prod_2-status')).toHaveTextContent('Draft');
    expect(within(screen.getByTestId('prod_2-name')).getByRole('presentation')).toHaveAttribute('src', 'https://img/x.png');
  });

  it('opens the product panel from a row', async () => {
    render(<ProductsList {...props} products={[product()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'open Linen shirt' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'product', id: 'prod_1' });
  });

  it('creates through the shared product dialog', async () => {
    render(<ProductsList {...props} products={[product()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'New product' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('new product');
  });

  it('edits through the shared product dialog', async () => {
    render(<ProductsList {...props} products={[product()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'edit Linen shirt' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('editing Linen shirt');
  });

  it('asks before deleting, then deletes', async () => {
    env.deleteProduct.mockResolvedValue(undefined);
    render(<ProductsList {...props} products={[product()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'delete Linen shirt' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete this product?');
    expect(dialog).toHaveTextContent('"Linen shirt" will be deleted.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(env.deleteProduct).toHaveBeenCalledWith('prod_1');
    expect(toast.success).toHaveBeenCalledWith('Product deleted');
  });

  it('says why a delete failed', async () => {
    env.deleteProduct.mockRejectedValue(new Error('Product has orders'));
    render(<ProductsList {...props} products={[product()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'delete Linen shirt' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(toast.error).toHaveBeenCalledWith('Product has orders');
  });

  it('offers no create, edit or delete to a member who may only read', () => {
    env.allowed = new Set();
    render(<ProductsList {...props} products={[]} />);
    expect(screen.queryByRole('button', { name: 'New product' })).not.toBeInTheDocument();
    expect(screen.getByText('No products yet')).toBeInTheDocument();
    env.createIntent?.();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the create form from the command palette when allowed', async () => {
    const { rerender } = render(<ProductsList {...props} products={[]} />);
    act(() => env.createIntent?.());
    rerender(<ProductsList {...props} products={[]} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('new product');
  });
});
