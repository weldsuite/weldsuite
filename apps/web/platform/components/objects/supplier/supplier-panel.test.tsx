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
  useWeldstashSupplier: () => ({
    data: { data: { id: 'sup_1', name: 'Acme', code: 'ACM', status: 'active', isActive: true } },
    isLoading: false,
    error: null,
  }),
}));
vi.mock('@/app/weldstash/product-suppliers/components/product-suppliers-section', () => ({
  ProductSuppliersSection: ({ side, supplierId }: { side: string; supplierId: string }) => (
    <div data-testid="suppliers-section">{`${side}:${supplierId}`}</div>
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

import { SupplierPanel } from './supplier-panel';

const props = { id: 'sup_1' } as React.ComponentProps<typeof SupplierPanel>;

function offerReplenishment() {
  setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash'], unavailableFeatures: [] } as never);
}

beforeEach(() => {
  env.permissions = { can: (permission) => permission === 'weldstash:suppliers:read' };
});

afterEach(() => setRuntimeConfig(null));

describe('SupplierPanel Products tab', () => {
  it('shows the Products tab with the supplier side of the product suppliers on the Rust editions', () => {
    offerReplenishment();
    render(<SupplierPanel {...props} />);
    expect(screen.getByTestId('tab-products')).toBeInTheDocument();
    expect(screen.getByTestId('suppliers-section')).toHaveTextContent('supplier:sup_1');
    expect(screen.getByTestId('tab-overview')).toBeInTheDocument();
  });

  it('is only the details tab on Global', () => {
    render(<SupplierPanel {...props} />);
    expect(screen.queryByTestId('tab-products')).not.toBeInTheDocument();
    expect(screen.getByTestId('tab-overview')).toBeInTheDocument();
  });

  it('is only the details tab without the permission to read suppliers', () => {
    offerReplenishment();
    env.permissions = { can: () => false };
    render(<SupplierPanel {...props} />);
    expect(screen.queryByTestId('tab-products')).not.toBeInTheDocument();
  });

  it('is only the details tab when there is no permission context', () => {
    offerReplenishment();
    env.permissions = null;
    render(<SupplierPanel {...props} />);
    expect(screen.queryByTestId('tab-products')).not.toBeInTheDocument();
  });
});
