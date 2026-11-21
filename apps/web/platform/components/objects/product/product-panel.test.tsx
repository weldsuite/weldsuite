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

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => env.permissions,
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashProduct: () => ({
    data: { data: { id: 'prod_1', name: 'Widget', sku: 'W-1', status: 'active', price: '10', currency: 'EUR', images: [] } },
    isLoading: false,
    error: null,
  }),
  useWeldstashStock: () => ({ data: { data: [] } }),
  useWeldstashMovements: () => ({ data: { data: [] } }),
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
