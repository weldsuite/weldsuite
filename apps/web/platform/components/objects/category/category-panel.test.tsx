import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceCategory, CommerceProduct } from '@/hooks/queries/use-commerce-queries';

interface StubTab {
  id: string;
  label: string;
  count?: number;
  hidden?: boolean;
}
interface StubField {
  label: string;
  value: ReactNode;
}

const env = vi.hoisted(() => ({
  category: null as CommerceCategory | null,
  members: [] as Partial<CommerceProduct>[],
  totalCount: 0,
  hasNextPage: false,
  children: [] as Partial<CommerceCategory>[],
  allowed: true,
  open: vi.fn(),
  fetchNextPage: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  navigation: [] as { type: string; ids: string[]; loadMore?: () => void }[],
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed && permission === 'categories:update' }),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.open }),
  useObjectPanelNavigationSource: (source: { type: string; ids: string[]; loadMore?: () => void }) => env.navigation.push(source),
}));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useCommerceCategory: () => ({ data: env.category ? { data: env.category } : undefined, isLoading: false, error: null }),
  useCommerceCategoryProducts: () => ({
    data: { pages: [{ data: env.members, pagination: { totalCount: env.totalCount, hasMore: env.hasNextPage, cursor: null } }] },
    hasNextPage: env.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: env.fetchNextPage,
  }),
  useCommerceCategories: () => ({ data: { data: env.children } }),
  useAttachCategoryProducts: () => ({ mutateAsync: env.attach, isPending: false }),
  useDetachCategoryProduct: () => ({ mutateAsync: env.detach }),
}));
vi.mock('./product-picker-dialog', () => ({
  ProductPickerDialog: ({
    open,
    existingIds,
    onConfirm,
  }: {
    open: boolean;
    existingIds: string[];
    onConfirm: (ids: string[]) => Promise<void>;
  }) =>
    open ? (
      <div role="dialog">
        <span>existing:{existingIds.join(',')}</span>
        <button type="button" onClick={() => void onConfirm(['prod_9', 'prod_8'])}>
          confirm
        </button>
      </div>
    ) : null,
}));
vi.mock('@/components/objects/_shared/simple-object-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/objects/_shared/simple-object-panel')>()),
  SimpleObjectPanel: ({
    tabs,
    renderTab,
    fields,
    extras,
    statusBadges,
    openHref,
  }: {
    tabs: StubTab[];
    renderTab: (tabId: string) => ReactNode;
    fields: StubField[];
    extras?: ReactNode;
    statusBadges?: ReactNode;
    openHref?: string;
  }) => (
    <div>
      <a data-testid="open-href" href={openHref}>
        open
      </a>
      <div data-testid="badges">{statusBadges}</div>
      <dl>
        {fields.map((field) => (
          <div key={field.label} data-testid={`field-${field.label}`}>
            {field.label}: {field.value}
          </div>
        ))}
      </dl>
      <div data-testid="extras">{extras}</div>
      {tabs
        .filter((tab) => !tab.hidden)
        .map((tab) => (
          <section key={tab.id} data-testid={`tab-${tab.id}`}>
            <h2>
              {tab.label}
              {tab.count ? ` (${tab.count})` : ''}
            </h2>
            {renderTab(tab.id)}
          </section>
        ))}
    </div>
  ),
}));

import { CategoryPanel } from './category-panel';

function category(overrides: Partial<CommerceCategory> = {}): CommerceCategory {
  return {
    id: 'cat_1',
    name: 'Shirts',
    slug: 'shirts',
    description: 'All our shirts',
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

const props = { id: 'cat_1', isOpen: true, onClose: vi.fn() };

beforeEach(() => {
  env.category = category();
  env.members = [
    { id: 'prod_1', name: 'Linen shirt', sku: 'L-1', price: 40, currency: 'EUR', featuredImageUrl: 'https://img/1.png' },
    { id: 'prod_2', name: 'Oxford shirt', sku: null, price: 50, currency: 'EUR' },
  ];
  env.totalCount = 2;
  env.hasNextPage = false;
  env.children = [{ id: 'cat_2', name: 'Linen', isActive: false }];
  env.allowed = true;
  env.open.mockReset();
  env.fetchNextPage.mockReset();
  env.attach.mockReset();
  env.detach.mockReset();
  env.navigation = [];
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('CategoryPanel', () => {
  it('shows the category, its products and its subcategories', () => {
    render(<CategoryPanel {...props} />);
    expect(screen.getByTestId('open-href')).toHaveAttribute('href', '/weldcommerce/categories?open=cat_1');
    expect(screen.getByTestId('badges')).toHaveTextContent('Manual');
    expect(screen.getByTestId('badges')).toHaveTextContent('Active');
    expect(screen.getByTestId('field-Products')).toHaveTextContent('2');
    expect(screen.getByTestId('extras')).toHaveTextContent('All our shirts');
    expect(screen.getByRole('heading', { name: 'Products (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Linen shirt · L-1' })).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(env.navigation.map((n) => n.type)).toEqual(expect.arrayContaining(['product', 'category']));
  });

  it('opens a product or a subcategory on top of the category', async () => {
    const user = userEvent.setup();
    render(<CategoryPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Oxford shirt' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'product', id: 'prod_2', stack: true });
    await user.click(screen.getByRole('button', { name: 'Linen' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'category', id: 'cat_2', stack: true });
  });

  it('adds products with the picker and removes one', async () => {
    env.attach.mockResolvedValue({ data: { added: 2 } });
    env.detach.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CategoryPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Add products' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('existing:prod_1,prod_2');
    await user.click(screen.getByRole('button', { name: 'confirm' }));
    expect(env.attach).toHaveBeenCalledWith({ categoryId: 'cat_1', productIds: ['prod_9', 'prod_8'] });
    expect(toast.success).toHaveBeenCalledWith('2 products added');

    await user.click(screen.getByRole('button', { name: 'Remove Linen shirt from the category' }));
    expect(env.detach).toHaveBeenCalledWith({ categoryId: 'cat_1', productId: 'prod_1' });
    expect(toast.success).toHaveBeenCalledWith('Product removed from the category');
  });

  it('says why adding or removing failed', async () => {
    env.attach.mockRejectedValue(new Error('Category is automated'));
    env.detach.mockRejectedValue(new Error('Not a member'));
    const user = userEvent.setup();
    render(<CategoryPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Add products' }));
    await user.click(screen.getByRole('button', { name: 'confirm' }));
    expect(toast.error).toHaveBeenCalledWith('Category is automated');
    await user.click(screen.getByRole('button', { name: 'Remove Oxford shirt from the category' }));
    expect(toast.error).toHaveBeenCalledWith('Not a member');
  });

  it('loads more products', async () => {
    env.hasNextPage = true;
    env.totalCount = 60;
    render(<CategoryPanel {...props} />);
    expect(screen.getByRole('heading', { name: 'Products (60)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(env.fetchNextPage).toHaveBeenCalled();
    env.navigation.find((n) => n.type === 'product')?.loadMore?.();
    expect(env.fetchNextPage).toHaveBeenCalledTimes(2);
  });

  it('shows an automated category’s rules and lets nobody change its members', () => {
    env.category = category({
      type: 'automated',
      description: null,
      rulesMatch: 'any',
      rules: [
        { column: 'price', relation: 'less_than', condition: '20' },
        { column: 'tag', relation: 'equals', condition: 'sale' },
      ],
    });
    render(<CategoryPanel {...props} />);
    expect(screen.getByTestId('badges')).toHaveTextContent('Automated');
    expect(screen.getByTestId('extras')).toHaveTextContent('Products match any of these rules.');
    expect(screen.getByTestId('extras')).toHaveTextContent('Price is less than 20');
    expect(screen.getByTestId('extras')).toHaveTextContent('Tag is equal to sale');
    expect(screen.getByText(/The products come from the rules/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add products' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove .* from the category/ })).not.toBeInTheDocument();
  });

  it('is read-only without categories:update, with empty states and no subcategories tab', () => {
    env.allowed = false;
    env.members = [];
    env.totalCount = 0;
    env.children = [];
    env.category = category({ description: null, isActive: false });
    render(<CategoryPanel {...props} />);
    expect(screen.queryByRole('button', { name: 'Add products' })).not.toBeInTheDocument();
    expect(screen.getByText('No products in this category yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-subcategories')).not.toBeInTheDocument();
    expect(screen.getByTestId('badges')).toHaveTextContent('Inactive');
  });
});
