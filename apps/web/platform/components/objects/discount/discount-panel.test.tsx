import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceDiscount, DiscountRedemption } from '@/hooks/queries/use-commerce-orders-queries';

interface StubTab {
  id: string;
  label: string;
}
interface StubField {
  label: string;
  value: ReactNode;
}

const env = vi.hoisted(() => ({
  discount: null as unknown,
  redemptions: [] as Partial<DiscountRedemption>[],
  hasNextPage: false,
  isError: false,
  canEdit: true,
  open: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.canEdit && permission === 'discounts:update' }),
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: env.open }) }));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCommerceDiscount: () => ({ data: env.discount ? { data: env.discount } : undefined, isLoading: false, error: null }),
  useCommerceDiscountRedemptions: () => ({
    data: { pages: [{ data: env.redemptions }] },
    isLoading: false,
    isError: env.isError,
    hasNextPage: env.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: env.fetchNextPage,
  }),
}));
vi.mock('@/app/weldcommerce/discounts/components/discount-dialog', () => ({
  DiscountDialog: ({ discount }: { discount?: CommerceDiscount }) => <div role="dialog">editing {discount?.name}</div>,
}));
vi.mock('@/components/objects/_shared/simple-object-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/objects/_shared/simple-object-panel')>()),
  SimpleObjectPanel: ({
    tabs,
    renderTab,
    fields,
    extras,
    statusBadges,
    title,
    subtitle,
  }: {
    tabs: StubTab[];
    renderTab: (tabId: string) => ReactNode;
    fields: StubField[];
    extras?: ReactNode;
    statusBadges?: ReactNode;
    title?: string;
    subtitle?: string;
  }) => (
    <div>
      <h1>{title}</h1>
      <p data-testid="subtitle">{subtitle}</p>
      <div data-testid="badges">{statusBadges}</div>
      {fields
        .filter((field) => field.value !== null && field.value !== undefined && field.value !== '')
        .map((field) => (
          <div key={field.label} data-testid={`field-${field.label}`}>
            {field.label}: {field.value}
          </div>
        ))}
      <div data-testid="extras">{extras}</div>
      {tabs.map((tab) => (
        <section key={tab.id} data-testid={`tab-${tab.id}`}>
          <h2>{tab.label}</h2>
          {renderTab(tab.id)}
        </section>
      ))}
    </div>
  ),
}));

import { DiscountPanel } from './discount-panel';

function discount(overrides: Partial<CommerceDiscount> = {}): CommerceDiscount {
  return {
    id: 'dsc_1',
    name: 'Spring sale',
    description: 'For the spring campaign',
    code: 'SPRING',
    type: 'percentage',
    value: '15.00',
    currency: null,
    maxDiscountAmount: null,
    appliesTo: 'products',
    productIds: ['p1', 'p2'],
    variantIds: [],
    categoryIds: [],
    minimumSubtotal: null,
    minimumQuantity: 2,
    usageLimit: 100,
    usageLimitPerCustomer: 1,
    usageCount: 12,
    status: 'active',
    effectiveStatus: 'active',
    startsAt: null,
    endsAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const props = { id: 'dsc_1', isOpen: true, onClose: vi.fn() };

beforeEach(() => {
  env.discount = discount();
  env.redemptions = [];
  env.hasNextPage = false;
  env.isError = false;
  env.canEdit = true;
  env.open.mockReset();
  env.fetchNextPage.mockReset();
});

describe('DiscountPanel', () => {
  it('titles the panel with the name and the code and shows the effective status', () => {
    render(<DiscountPanel {...props} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Spring sale');
    expect(screen.getByTestId('subtitle').textContent).toBe('SPRING');
    expect(within(screen.getByTestId('badges')).getByText('Active')).toBeTruthy();
  });

  it('shows what the code takes off, what it applies to, its minimums and its usage', () => {
    render(<DiscountPanel {...props} />);
    expect(screen.getByTestId('field-Discount').textContent).toContain('15%');
    expect(screen.getByTestId('field-Applies to').textContent).toContain('2 products');
    expect(screen.getByTestId('field-Minimum quantity').textContent).toContain('2');
    expect(screen.getByTestId('field-Used').textContent).toContain('12 of 100');
    expect(screen.getByTestId('field-Valid').textContent).toContain('Any time');
    expect(screen.queryByTestId('field-Minimum order amount')).toBeNull();
  });

  it('counts categories and says everything for a code with no scope', () => {
    env.discount = discount({ appliesTo: 'categories', categoryIds: ['c1'] });
    const { rerender } = render(<DiscountPanel {...props} />);
    expect(screen.getByTestId('field-Applies to').textContent).toContain('1 category');

    env.discount = discount({ appliesTo: 'all' });
    rerender(<DiscountPanel {...props} />);
    expect(screen.getByTestId('field-Applies to').textContent).toContain('Everything on the order');
  });

  it('lets a member who may update edit it', async () => {
    const user = userEvent.setup();
    render(<DiscountPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog').textContent).toBe('editing Spring sale');
  });

  it('has no Edit for a member who may not', () => {
    env.canEdit = false;
    render(<DiscountPanel {...props} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('says when a code has not been used', () => {
    render(<DiscountPanel {...props} />);
    expect(within(screen.getByTestId('tab-redemptions')).getByText('This code has not been used yet.')).toBeTruthy();
  });

  it('lists the redemptions with the order, the customer and the amount, and opens the order', async () => {
    env.redemptions = [
      { id: 'red_1', orderId: 'ord_1', orderNumber: 'WC-1001', customerEmail: 'ada@example.com', amount: '7.50', currency: 'EUR', createdAt: '2026-11-10T09:00:00.000Z' },
      { id: 'red_2', orderId: 'ord_2', orderNumber: null, customerEmail: null, amount: '3.00', currency: 'EUR', createdAt: '2026-11-11T09:00:00.000Z' },
    ];
    env.hasNextPage = true;
    const user = userEvent.setup();
    render(<DiscountPanel {...props} />);
    const tab = within(screen.getByTestId('tab-redemptions'));
    expect(tab.getByText(/ada@example.com/)).toBeTruthy();
    expect(tab.getByText(/7\.50/)).toBeTruthy();
    await user.click(tab.getByRole('button', { name: 'Order WC-1001' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'order', id: 'ord_1', stack: true });
    await user.click(tab.getByRole('button', { name: 'Order' }));
    expect(env.open).toHaveBeenLastCalledWith({ type: 'order', id: 'ord_2', stack: true });
    await user.click(tab.getByRole('button', { name: 'Load more' }));
    expect(env.fetchNextPage).toHaveBeenCalled();
  });

  it('says when the redemptions could not load', () => {
    env.isError = true;
    render(<DiscountPanel {...props} />);
    expect(within(screen.getByTestId('tab-redemptions')).getByText('Could not load the redemptions.')).toBeTruthy();
  });
});
