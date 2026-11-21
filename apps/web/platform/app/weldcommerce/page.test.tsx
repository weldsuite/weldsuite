import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceOverview } from '@/hooks/queries/use-commerce-queries';

const env = vi.hoisted(() => ({
  overview: undefined as CommerceOverview | undefined,
  isLoading: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useCommerceOverview: () => ({
    data: env.overview ? { data: env.overview } : undefined,
    isLoading: env.isLoading,
    error: env.error,
    refetch: env.refetch,
  }),
}));

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import WeldCommerceOverview from './page';

const full: CommerceOverview = {
  products: { total: 12, active: 9, draft: 3 },
  orders: { total: 40, open: 5, awaitingFulfilment: 4, unpaid: 2 },
  revenueLast30Days: [
    { currency: 'EUR', orders: 7, revenue: '1234.50' },
    { currency: 'PLN', orders: 1, revenue: '99.00' },
  ],
  recentOrders: [
    {
      id: 'ord_1',
      orderNumber: '1001',
      source: 'woocommerce',
      status: 'processing',
      paymentStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      currency: 'EUR',
      total: '25.50',
      customerName: 'Grace Hopper',
      createdAt: '2026-11-20T10:00:00.000Z',
    },
    {
      id: 'ord_2',
      orderNumber: null,
      source: 'web',
      status: 'cancelled',
      paymentStatus: null,
      fulfillmentStatus: 'fulfilled',
      currency: null,
      total: null,
      customerName: null,
      createdAt: '2026-11-19T10:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  env.overview = undefined;
  env.isLoading = false;
  env.error = null;
  env.refetch.mockReset();
});

describe('WeldCommerce overview', () => {
  it('shows the counts, the revenue per currency and the newest orders', () => {
    env.overview = full;
    render(<WeldCommerceOverview />);

    expect(screen.getByText('Products')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('9 active · 3 draft')).toBeTruthy();
    expect(screen.getByText('Open orders')).toBeTruthy();
    expect(screen.getByText('Awaiting fulfilment')).toBeTruthy();
    expect(screen.getByText('Unpaid')).toBeTruthy();

    expect(screen.getByText('Revenue, last 30 days')).toBeTruthy();
    expect(screen.getByText('7 orders')).toBeTruthy();
    expect(screen.getByText('1 orders')).toBeTruthy();

    expect(screen.getByText('Recent orders')).toBeTruthy();
    expect(screen.getByText('1001')).toBeTruthy();
    // Each order opens its panel on the orders list.
    expect(screen.getByRole('link', { name: '1001' }).getAttribute('href')).toBe('/weldcommerce/orders?open=ord_1');
    expect(screen.getByRole('link', { name: 'ord_2' }).getAttribute('href')).toBe('/weldcommerce/orders?open=ord_2');
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    // An order without a number shows its id; statuses read as words.
    expect(screen.getByText('ord_2')).toBeTruthy();
    expect(screen.getByText('processing')).toBeTruthy();
    expect(screen.getByText('cancelled')).toBeTruthy();
  });

  it('leaves out the sections the member may not read', () => {
    env.overview = { ...full, orders: null, revenueLast30Days: null, recentOrders: null };
    render(<WeldCommerceOverview />);
    expect(screen.getByText('Products')).toBeTruthy();
    expect(screen.queryByText('Open orders')).toBeNull();
    expect(screen.queryByText('Revenue, last 30 days')).toBeNull();
    expect(screen.queryByText('Recent orders')).toBeNull();
  });

  it('says so when there is no revenue and no order yet', () => {
    env.overview = { ...full, revenueLast30Days: [], recentOrders: [] };
    render(<WeldCommerceOverview />);
    expect(screen.getByText('No orders in the last 30 days.')).toBeTruthy();
    expect(screen.getByText(/No orders yet/)).toBeTruthy();
  });

  it('offers a retry when the overview fails to load', async () => {
    env.error = new Error('boom');
    render(<WeldCommerceOverview />);
    expect(screen.getByText('Could not load the overview.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button'));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('shows placeholders while loading', () => {
    env.isLoading = true;
    render(<WeldCommerceOverview />);
    expect(screen.getByText('Products')).toBeTruthy();
    expect(screen.getByText('Open orders')).toBeTruthy();
  });
});
