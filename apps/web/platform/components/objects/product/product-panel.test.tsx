import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setRuntimeConfig } from '@/lib/runtime-config';

interface StubTab {
  id: string;
  label: string;
}

const env = vi.hoisted(() => ({
  permissions: null as { can: (permission: string) => boolean } | null,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => env.permissions,
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: vi.fn() }),
  useObjectPanelNavigationSource: () => undefined,
}));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useCommerceProduct: () => ({
    data: { data: { id: 'prod_1', name: 'Widget', sku: 'W-1', status: 'active', price: '10', currency: 'EUR', salesChannels: [], images: [] } },
    isLoading: false,
    error: null,
  }),
  useCommerceProductCategories: () => ({ data: { data: [] } }),
  useAttachCategoryProducts: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDetachCategoryProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashStock: () => ({ data: { data: [] } }),
  useWeldstashMovements: () => ({ data: { data: [] } }),
}));
vi.mock('./category-picker-dialog', () => ({ CategoryPickerDialog: () => null }));
vi.mock('@/app/weldcommerce/products/components/product-sales-channels-editor', () => ({
  ProductSalesChannelsEditor: () => <div>channels editor</div>,
}));
vi.mock('@/app/weldstash/product-suppliers/components/product-suppliers-section', () => ({
  ProductSuppliersSection: ({ side, productId }: { side: string; productId: string }) => (
    <div data-testid="suppliers-section">{`${side}:${productId}`}</div>
  ),
}));
vi.mock('@/components/objects/_shared/simple-object-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/objects/_shared/simple-object-panel')>()),
  SimpleObjectPanel: ({ tabs, renderTab }: { tabs: StubTab[]; renderTab?: (tabId: string) => ReactNode }) => (
    <div>
      {tabs.map((tab) => (
        <section key={tab.id} data-testid={`tab-${tab.id}`}>
          <h2>{tab.label}</h2>
          {renderTab?.(tab.id)}
        </section>
      ))}
    </div>
  ),
}));

import { ProductPanel } from './product-panel';

const props = { id: 'prod_1' } as React.ComponentProps<typeof ProductPanel>;

function offerReplenishment() {
  setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash'], unavailableFeatures: [] } as never);
}

beforeEach(() => {
  env.permissions = { can: (permission) => permission === 'weldstash:suppliers:read' };
});

afterEach(() => setRuntimeConfig(null));

describe('ProductPanel Suppliers tab', () => {
  it('shows the Suppliers tab with the product side of the product suppliers on the Rust editions', () => {
    offerReplenishment();
    render(<ProductPanel {...props} />);
    expect(screen.getByTestId('tab-suppliers')).toBeInTheDocument();
    expect(screen.getByTestId('suppliers-section')).toHaveTextContent('product:prod_1');
  });

  it('has no Suppliers tab on Global', () => {
    render(<ProductPanel {...props} />);
    expect(screen.queryByTestId('tab-suppliers')).not.toBeInTheDocument();
    expect(screen.getByTestId('tab-stock')).toBeInTheDocument();
  });

  it('has no Suppliers tab without the permission to read suppliers', () => {
    offerReplenishment();
    env.permissions = { can: () => false };
    render(<ProductPanel {...props} />);
    expect(screen.queryByTestId('tab-suppliers')).not.toBeInTheDocument();
  });

  it('has no Suppliers tab when there is no permission context', () => {
    offerReplenishment();
    env.permissions = null;
    render(<ProductPanel {...props} />);
    expect(screen.queryByTestId('tab-suppliers')).not.toBeInTheDocument();
  });
});
