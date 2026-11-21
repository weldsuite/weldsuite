import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setRuntimeConfig } from '@/lib/runtime-config';

interface StubTab {
  id: string;
  label: string;
}

const env = vi.hoisted(() => ({
  permissions: null as { can: (permission: string) => boolean; app?: string | null } | null,
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
vi.mock('@/app/weldcommerce/products/components/product-variants-section', () => ({
  ProductVariantsSection: ({ productId, canEdit }: { productId: string; canEdit: boolean }) => (
    <div data-testid="variants-section">{`${productId}:${canEdit ? 'edit' : 'read'}`}</div>
  ),
}));
vi.mock('@/app/weldcommerce/products/components/product-prices-section', () => ({
  ProductPricesSection: ({ productId, canEdit }: { productId: string; canEdit: boolean }) => (
    <div data-testid="prices-section">{`${productId}:${canEdit ? 'edit' : 'read'}`}</div>
  ),
}));
vi.mock('@/app/weldcommerce/products/components/product-categories-section', () => ({
  ProductCategoriesSection: ({ productId }: { productId: string }) => <div data-testid="categories-section">{productId}</div>,
}));
vi.mock('@/components/objects/_shared/simple-object-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/objects/_shared/simple-object-panel')>()),
  SimpleObjectPanel: ({
    tabs,
    renderTab,
    openHref,
  }: {
    tabs: StubTab[];
    renderTab?: (tabId: string) => ReactNode;
    openHref?: string;
  }) => (
    <div>
      <a data-testid="open-href" href={openHref}>
        open
      </a>
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

describe('ProductPanel in WeldCommerce', () => {
  function offerCommerce() {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash', 'commerce'], unavailableFeatures: [] } as never);
  }

  it('adds the Variants, Prices and Categories tabs and links to the WeldCommerce list', () => {
    offerCommerce();
    env.permissions = { app: 'weldcommerce', can: (permission) => permission !== 'weldstash:suppliers:read' };
    render(<ProductPanel {...props} />);
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Details', 'Variants', 'Prices', 'Stock', 'Categories', 'Movements']);
    expect(screen.getByTestId('variants-section')).toHaveTextContent('prod_1:edit');
    expect(screen.getByTestId('prices-section')).toHaveTextContent('prod_1:edit');
    expect(screen.getByTestId('categories-section')).toHaveTextContent('prod_1');
    expect(screen.getByTestId('open-href')).toHaveAttribute('href', '/weldcommerce/products?stack=product:prod_1');
  });

  it('shows variants read-only without products:update, and no categories without categories:read', () => {
    offerCommerce();
    env.permissions = { app: 'weldcommerce', can: (permission) => permission === 'products:read' };
    render(<ProductPanel {...props} />);
    expect(screen.getByTestId('variants-section')).toHaveTextContent('prod_1:read');
    expect(screen.getByTestId('prices-section')).toHaveTextContent('prod_1:read');
    expect(screen.queryByTestId('tab-categories')).not.toBeInTheDocument();
  });

  it('keeps WeldStash’s panel as it is in WeldStash', () => {
    offerCommerce();
    env.permissions = { app: 'weldstash', can: () => true };
    render(<ProductPanel {...props} />);
    expect(screen.queryByTestId('tab-variants')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tab-prices')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tab-categories')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-href')).toHaveAttribute('href', '/weldstash/products?stack=product:prod_1');
  });

  it('has neither tab where WeldCommerce is not offered (Global)', () => {
    env.permissions = { app: 'weldcommerce', can: () => true };
    render(<ProductPanel {...props} />);
    expect(screen.queryByTestId('tab-variants')).not.toBeInTheDocument();
  });
});
