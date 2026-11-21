import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProductPrice } from '@/hooks/queries/use-commerce-channels-queries';

const env = vi.hoisted(() => ({
  prices: { data: { data: [] as ProductPrice[] }, isLoading: false, error: null as unknown },
  variants: { data: { data: [] as unknown[] } },
  save: vi.fn(),
  variantsEnabled: undefined as boolean | undefined,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-commerce-channels-queries', () => ({
  useProductPrices: () => env.prices,
  useSaveProductPrices: () => ({ mutateAsync: env.save, isPending: false }),
}));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useProductVariants: (_id: string, enabled: boolean) => {
    env.variantsEnabled = enabled;
    return env.variants;
  },
}));

import { ProductPricesSection } from './product-prices-section';

const stored: ProductPrice = { id: 'pp1', productId: 'prod_1', variantId: null, currency: 'USD', price: '12.00', compareAtPrice: null };

function renderSection(props: Partial<Parameters<typeof ProductPricesSection>[0]> = {}) {
  return render(<ProductPricesSection productId="prod_1" basePrice="10.00" baseCurrency="EUR" canEdit {...props} />);
}

beforeEach(() => {
  env.prices = { data: { data: [stored] }, isLoading: false, error: null };
  env.variants = { data: { data: [] } };
  env.save.mockReset();
  env.save.mockResolvedValue({ data: [] });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ProductPricesSection', () => {
  it('shows the base price and the price in another currency', () => {
    renderSection();
    expect(screen.getByText(/Base price: .*10\.00/)).toBeTruthy();
    expect(screen.getByLabelText('Currency — This product')).toHaveProperty('value', 'USD');
    expect(screen.getByLabelText('Price — This product')).toHaveProperty('value', '12.00');
  });

  it('lists the variants, from the given list or, without one, from the variants query', () => {
    env.variants = { data: { data: [{ id: 'v1', name: 'L / Red', sku: 'S-1', optionValues: {}, price: null, currency: null }] } };
    renderSection();
    expect(env.variantsEnabled).toBe(true);
    expect(screen.getByText('L / Red')).toBeTruthy();
    expect(screen.getByText('Uses the product price')).toBeTruthy();
  });

  it('does not fetch variants it was given', () => {
    renderSection({ variants: [{ id: 'v2', name: 'XL', sku: null, optionValues: {}, price: '11.00', currency: 'EUR' }] });
    expect(env.variantsEnabled).toBe(false);
    expect(screen.getByText('XL')).toBeTruthy();
  });

  it('keeps Save off until something changed, then saves the whole set', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    await user.clear(screen.getByLabelText('Price — This product'));
    await user.type(screen.getByLabelText('Price — This product'), '13.5');
    await user.click(screen.getByRole('button', { name: 'Add a currency' }));
    const currencies = screen.getAllByLabelText('Currency — This product');
    await user.type(currencies[1], 'gbp');
    await user.type(screen.getAllByLabelText('Price — This product')[1], '9');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.save).toHaveBeenCalled());
    expect(env.save).toHaveBeenCalledWith({
      productId: 'prod_1',
      prices: [
        { variantId: null, currency: 'USD', price: '13.50', compareAtPrice: null },
        { variantId: null, currency: 'GBP', price: '9.00', compareAtPrice: null },
      ],
    });
    expect(toast.success).toHaveBeenCalledWith('Prices saved');
  });

  it('removes a price from the set', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Remove price — This product' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.save).toHaveBeenCalledWith({ productId: 'prod_1', prices: [] }));
  });

  it('marks a bad row and does not save', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Add a currency' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findAllByText('Enter a three-letter currency code.')).toHaveLength(1);
    expect(screen.getByText('Enter a price such as 12.50.')).toBeTruthy();
    expect(env.save).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Fix the prices marked in red.');
    expect(screen.getAllByLabelText('Currency — This product')[1].getAttribute('aria-invalid')).toBe('true');
  });

  it('shows a failed save in a toast and keeps the edits', async () => {
    env.save.mockRejectedValue(new Error('Server on fire'));
    const user = userEvent.setup();
    renderSection();
    await user.clear(screen.getByLabelText('Price — This product'));
    await user.type(screen.getByLabelText('Price — This product'), '13');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server on fire'));
    expect(screen.getByLabelText('Price — This product')).toHaveProperty('value', '13');
  });

  it('is read-only without edit rights', () => {
    renderSection({ canEdit: false });
    expect(screen.queryByRole('button', { name: 'Add a currency' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByLabelText('Price — This product').matches(':disabled')).toBe(true);
  });

  it('says so when the prices cannot be loaded', () => {
    env.prices = { data: { data: [] }, isLoading: false, error: new Error('x') };
    renderSection();
    expect(screen.getByText('Could not load the prices.')).toBeTruthy();
  });
});
