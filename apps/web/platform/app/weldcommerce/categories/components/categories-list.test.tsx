import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import type { CommerceCategory } from '@/hooks/queries/use-commerce-queries';

interface StubColumn {
  id: string;
  render: (row: CommerceCategory) => ReactNode;
}

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  open: vi.fn(),
  deleteCategory: vi.fn(),
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
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useDeleteCommerceCategory: () => ({ mutateAsync: env.deleteCategory }),
}));
vi.mock('./category-dialog', () => ({
  CategoryDialog: ({ category }: { category?: CommerceCategory }) => (
    <div role="dialog">{category ? `editing ${category.name}` : 'new category'}</div>
  ),
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
  }: {
    items: CommerceCategory[];
    columns: StubColumn[];
    onRowClick: (row: CommerceCategory) => void;
    onEdit?: (row: CommerceCategory) => void;
    onDelete?: (row: CommerceCategory) => void;
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

import { CategoriesList } from './categories-list';

function category(overrides: Partial<CommerceCategory> = {}): CommerceCategory {
  return {
    id: 'cat_1',
    name: 'Clothing',
    slug: 'clothing',
    description: null,
    parentId: null,
    path: null,
    depth: 0,
    type: 'manual',
    rules: null,
    rulesMatch: null,
    isActive: true,
    sortOrder: null,
    publishedAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

const rows = [
  category(),
  category({ id: 'cat_2', name: 'Sale', slug: '', depth: 1, type: 'automated', isActive: false }),
];
const props = { isLoading: false, search: '', onSearchChange: vi.fn(), categories: rows };

beforeEach(() => {
  env.allowed = new Set(['categories:create', 'categories:update', 'categories:delete']);
  env.open.mockReset();
  env.deleteCategory.mockReset();
  env.createIntent = null;
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('CategoriesList', () => {
  it('indents children in the tree and shows type and status', () => {
    render(<CategoriesList {...props} showHierarchy />);
    expect(screen.getByTestId('cat_2-name').firstElementChild).toHaveStyle({ paddingLeft: '20px' });
    expect(screen.getByTestId('cat_1-slug')).toHaveTextContent('clothing');
    expect(screen.getByTestId('cat_2-slug')).toHaveTextContent('—');
    expect(screen.getByTestId('cat_1-type')).toHaveTextContent('Manual');
    expect(screen.getByTestId('cat_2-type')).toHaveTextContent('Automated');
    expect(screen.getByTestId('cat_1-status')).toHaveTextContent('Active');
    expect(screen.getByTestId('cat_2-status')).toHaveTextContent('Inactive');
  });

  it('does not indent search results', () => {
    render(<CategoriesList {...props} showHierarchy={false} />);
    expect(screen.getByTestId('cat_2-name').firstElementChild).toHaveStyle({ paddingLeft: '0px' });
  });

  it('opens the category panel, the create and the edit form', async () => {
    const user = userEvent.setup();
    render(<CategoriesList {...props} showHierarchy />);
    await user.click(screen.getByRole('button', { name: 'open Sale' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'category', id: 'cat_2' });
    await user.click(screen.getByRole('button', { name: 'New category' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('new category');
  });

  it('edits a category', async () => {
    render(<CategoriesList {...props} showHierarchy />);
    await userEvent.click(screen.getByRole('button', { name: 'edit Clothing' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('editing Clothing');
  });

  it('opens the create form from the command palette', () => {
    render(<CategoriesList {...props} showHierarchy />);
    act(() => env.createIntent?.());
    expect(screen.getByRole('dialog')).toHaveTextContent('new category');
  });

  it('asks before deleting, then deletes', async () => {
    env.deleteCategory.mockResolvedValue(undefined);
    render(<CategoriesList {...props} showHierarchy />);
    await userEvent.click(screen.getByRole('button', { name: 'delete Clothing' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete this category?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(env.deleteCategory).toHaveBeenCalledWith('cat_1');
    expect(toast.success).toHaveBeenCalledWith('Category deleted');
  });

  it('explains that a category with subcategories cannot be deleted', async () => {
    env.deleteCategory.mockRejectedValue(new ApiError('Category has children', 409));
    render(<CategoriesList {...props} showHierarchy />);
    await userEvent.click(screen.getByRole('button', { name: 'delete Clothing' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(toast.error).toHaveBeenCalledWith('This category has subcategories. Move or delete them first.');
  });

  it('shows the server’s message for other failures', async () => {
    env.deleteCategory.mockRejectedValue(new Error('Database is down'));
    render(<CategoriesList {...props} showHierarchy />);
    await userEvent.click(screen.getByRole('button', { name: 'delete Clothing' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(toast.error).toHaveBeenCalledWith('Database is down');
  });

  it('offers nothing to change to a member who may only read', () => {
    env.allowed = new Set();
    render(<CategoriesList {...props} categories={[]} showHierarchy />);
    expect(screen.queryByRole('button', { name: 'New category' })).not.toBeInTheDocument();
    expect(screen.getByText('No categories yet')).toBeInTheDocument();
    act(() => env.createIntent?.());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
