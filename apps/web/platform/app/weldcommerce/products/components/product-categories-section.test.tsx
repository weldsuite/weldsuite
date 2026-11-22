import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceCategoryRef } from '@/hooks/queries/use-commerce-queries';

const env = vi.hoisted(() => ({
  rows: [] as CommerceCategoryRef[],
  isLoading: false,
  error: null as Error | null,
  open: vi.fn(),
  navigation: [] as { type: string; ids: string[] }[],
}));

vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.open }),
  useObjectPanelNavigationSource: (source: { type: string; ids: string[] }) => env.navigation.push(source),
}));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useProductCategories: () => ({ data: { data: env.rows }, isLoading: env.isLoading, error: env.error }),
}));

import { ProductCategoriesSection } from './product-categories-section';

function ref(id: string, name: string, depth = 0, isActive = true): CommerceCategoryRef {
  return { id, name, slug: id, parentId: null, depth, type: 'manual', isActive };
}

beforeEach(() => {
  env.rows = [ref('cat_1', 'Clothing'), ref('cat_2', 'Shirts', 1, false)];
  env.isLoading = false;
  env.error = null;
  env.open.mockReset();
  env.navigation = [];
});

describe('ProductCategoriesSection', () => {
  it('lists the product’s manual categories, and opens one on top of the product', async () => {
    render(<ProductCategoriesSection productId="prod_1" />);
    expect(screen.getByRole('button', { name: 'Shirts' })).toHaveStyle({ paddingLeft: '12px' });
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText(/Automated categories find their products/)).toBeInTheDocument();
    expect(env.navigation.at(-1)).toEqual({ type: 'category', ids: ['cat_1', 'cat_2'] });

    await userEvent.click(screen.getByRole('button', { name: 'Clothing' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'category', id: 'cat_1', stack: true });
  });

  it('says when the product is in no category', () => {
    env.rows = [];
    render(<ProductCategoriesSection productId="prod_1" />);
    expect(screen.getByText('This product is not in any category yet.')).toBeInTheDocument();
  });

  it('shows loading and a failed load', () => {
    env.isLoading = true;
    const { unmount } = render(<ProductCategoriesSection productId="prod_1" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    unmount();
    env.isLoading = false;
    env.error = new Error('boom');
    render(<ProductCategoriesSection productId="prod_1" />);
    expect(screen.getByText('Could not load the categories.')).toBeInTheDocument();
  });
});
