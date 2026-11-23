import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  products: [] as Record<string, unknown>[],
  variants: [] as Record<string, unknown>[],
  isLoading: false,
  isError: false,
  params: [] as unknown[],
  variantsFor: [] as string[],
}));

vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashProducts: (params: unknown) => {
    env.params.push(params);
    return { data: { data: env.products, pagination: { totalCount: env.products.length } }, isLoading: env.isLoading, isError: env.isError };
  },
}));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useProductVariants: (productId: string) => {
    env.variantsFor.push(productId);
    return { data: { data: env.variants }, isLoading: false, isError: false };
  },
}));

import { OrderLinePickerDialog } from './order-line-picker-dialog';

function open() {
  const onPick = vi.fn();
  const onOpenChange = vi.fn();
  render(<OrderLinePickerDialog open onOpenChange={onOpenChange} onPick={onPick} />);
  return { onPick, onOpenChange, user: userEvent.setup() };
}

beforeEach(() => {
  env.products = [
    { id: 'prod_1', name: 'Wool coat', sku: 'COAT', price: 120, currency: 'EUR' },
    { id: 'prod_2', name: 'Linen shirt', sku: 'SHIRT', price: 40, currency: 'EUR', variantCount: 2, featuredImageUrl: 'https://img/2.png' },
  ];
  env.variants = [
    { id: 'var_1', name: 'M / Red', sku: 'SHIRT-M-R', price: '42.00', currency: 'EUR', status: 'active' },
    { id: 'var_2', name: 'L / Red', sku: 'SHIRT-L-R', price: null, currency: null, status: 'active' },
    { id: 'var_3', name: 'XL / Red', sku: 'SHIRT-XL-R', price: null, currency: null, status: 'archived' },
  ];
  env.isLoading = false;
  env.isError = false;
  env.params = [];
  env.variantsFor = [];
});

describe('OrderLinePickerDialog', () => {
  it('searches active products by name or SKU', async () => {
    const { user } = open();
    await user.type(screen.getByRole('searchbox', { name: 'Search by name or SKU…' }), 'shirt');
    expect(env.params.at(-1)).toEqual({ limit: 20, status: 'active', search: 'shirt' });
    expect(screen.getByRole('status').textContent).toBe('2 products found');
  });

  it('adds a product without variants as a catalogue line at the catalogue price', async () => {
    const { user, onPick, onOpenChange } = open();
    await user.click(screen.getByRole('button', { name: /Wool coat/ }));
    expect(onPick).toHaveBeenCalledWith({
      productId: 'prod_1',
      variantId: null,
      sku: 'COAT',
      name: 'Wool coat',
      variantName: null,
      quantity: 1,
      unitPrice: '',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the price of a product, and the variant count of one with variants', () => {
    open();
    expect(screen.getByRole('button', { name: /Wool coat/ }).textContent).toContain('120.00');
    expect(screen.getByRole('button', { name: /Linen shirt/ }).textContent).toContain('2 variants');
  });

  it('asks for the variant of a product that has them, leaves out archived ones, and adds the chosen variant', async () => {
    const { user, onPick } = open();
    await user.click(screen.getByRole('button', { name: /Linen shirt/ }));
    expect(onPick).not.toHaveBeenCalled();
    expect(env.variantsFor).toContain('prod_2');
    expect(screen.getByRole('heading', { name: 'Variants of Linen shirt' })).toBeTruthy();
    expect(screen.queryByText(/XL \/ Red/)).toBeNull();

    // A variant with no price of its own shows the product's.
    expect(screen.getByRole('button', { name: /L \/ Red/ }).textContent).toContain('40.00');

    await user.click(screen.getByRole('button', { name: /M \/ Red/ }));
    expect(onPick).toHaveBeenCalledWith({
      productId: 'prod_2',
      variantId: 'var_1',
      sku: 'SHIRT-M-R',
      name: 'Linen shirt',
      variantName: 'M / Red',
      quantity: 1,
      unitPrice: '',
    });
  });

  it('goes back from the variants to the products', async () => {
    const { user } = open();
    await user.click(screen.getByRole('button', { name: /Linen shirt/ }));
    await user.click(screen.getByRole('button', { name: 'Back to the products' }));
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('says when nothing was found, and when the products could not load', () => {
    env.products = [];
    const { unmount } = render(<OrderLinePickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByText('No products found.')).toBeTruthy();
    unmount();

    env.isError = true;
    render(<OrderLinePickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByText('Could not load the products.')).toBeTruthy();
  });
});
