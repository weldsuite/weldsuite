import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const env = vi.hoisted(() => ({
  access: { isInstalled: true, isLoading: false },
  get: vi.fn(),
}));

vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => env.access }));
vi.mock('@/contexts/breadcrumb-context', () => ({
  BreadcrumbProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => <header>header</header> }));
vi.mock('@/components/layout/module-content', () => ({
  ModuleContent: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: env.get }) }),
}));

import WeldCommerceLayout from './layout';
import { useCommerceOverview } from '@/hooks/queries/use-commerce-queries';

beforeEach(() => {
  env.access = { isInstalled: true, isLoading: false };
  env.get.mockReset();
});

describe('WeldCommerce layout', () => {
  it('renders the module when the app is installed', () => {
    render(<WeldCommerceLayout><p>page</p></WeldCommerceLayout>);
    expect(screen.getByText('page')).toBeTruthy();
    expect(screen.getByText('header')).toBeTruthy();
  });

  it('says the app is not installed', () => {
    env.access = { isInstalled: false, isLoading: false };
    render(<WeldCommerceLayout><p>page</p></WeldCommerceLayout>);
    expect(screen.getByText('WeldCommerce is not installed in this workspace.')).toBeTruthy();
    expect(screen.queryByText('page')).toBeNull();
  });

  it('waits while access is being checked', () => {
    env.access = { isInstalled: false, isLoading: true };
    render(<WeldCommerceLayout><p>page</p></WeldCommerceLayout>);
    expect(screen.queryByText('page')).toBeNull();
    expect(screen.queryByText('WeldCommerce is not installed in this workspace.')).toBeNull();
  });
});

describe('useCommerceOverview', () => {
  it('reads /commerce/overview', async () => {
    env.get.mockResolvedValue({ data: { products: null, orders: null, revenueLast30Days: null, recentOrders: null } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCommerceOverview(), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(env.get).toHaveBeenCalledWith('/commerce/overview');
    expect(result.current.data?.data.products).toBeNull();
  });
});
