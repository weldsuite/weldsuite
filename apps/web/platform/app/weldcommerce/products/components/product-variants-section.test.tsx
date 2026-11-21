import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import type { CommerceVariant } from '@/hooks/queries/use-commerce-queries';

const env = vi.hoisted(() => ({
  variants: [] as CommerceVariant[],
  isLoading: false,
  error: null as Error | null,
  generate: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useProductVariants: () => ({
    data: { data: env.variants },
    isLoading: env.isLoading,
    error: env.error,
  }),
  useGenerateProductVariants: () => ({ mutateAsync: env.generate, isPending: false }),
  useUpdateProductVariant: () => ({ mutateAsync: env.update }),
  useDeleteProductVariant: () => ({ mutateAsync: env.remove }),
}));

import { ProductVariantsSection } from './product-variants-section';
import { variantPatch } from './variant-row';

function variant(overrides: Partial<CommerceVariant> = {}): CommerceVariant {
  return {
    id: 'var_1',
    productId: 'prod_1',
    sku: 'SHIRT-S',
    barcode: '871000',
    optionValues: { Size: 'S' },
    price: null,
    currency: 'EUR',
    status: 'active',
    position: 0,
    inventoryQuantity: 4,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

function show(canEdit = true) {
  render(<ProductVariantsSection productId="prod_1" productPrice="40" currency="EUR" canEdit={canEdit} />);
  return userEvent.setup();
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.variants = [
    variant({ id: 'var_2', optionValues: { Size: 'M' }, sku: 'SHIRT-M', barcode: null, price: '45.00', position: 1, status: 'draft' }),
    variant(),
  ];
  env.isLoading = false;
  env.error = null;
  env.generate.mockReset();
  env.update.mockReset();
  env.remove.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ProductVariantsSection', () => {
  it('lists the variants in position order with their price, status and stock', () => {
    show();
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('S');
    expect(rows[0]).toHaveTextContent('SHIRT-S · 871000');
    // No price of its own: the product's, muted.
    expect(within(rows[0]).getByTitle('Product price')).toHaveTextContent('40.00');
    expect(rows[0]).toHaveTextContent('4 in stock');
    expect(rows[1]).toHaveTextContent('M');
    expect(rows[1]).toHaveTextContent('45.00');
    expect(rows[1]).toHaveTextContent('Draft');
  });

  it('explains variants to a product without them', () => {
    env.variants = [];
    show();
    expect(screen.getByText(/This product has no variants/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add options' })).toBeInTheDocument();
  });

  it('is read-only without products:update', () => {
    show(false);
    expect(screen.queryByRole('button', { name: 'Edit options' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit variant/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete variant/ })).not.toBeInTheDocument();
  });

  it('shows loading and a failed load', () => {
    env.isLoading = true;
    const { unmount } = render(<ProductVariantsSection productId="prod_1" productPrice="40" currency="EUR" canEdit />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    unmount();
    env.isLoading = false;
    env.error = new Error('boom');
    show();
    expect(screen.getByText('Could not load the variants.')).toBeInTheDocument();
  });

  it('generates variants from the options read back from the variants', async () => {
    env.generate.mockResolvedValue({ data: { created: 1, kept: 2, variants: [] } });
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Edit options' }));
    expect(screen.getByLabelText('Option name')).toHaveValue('Size');
    await user.type(screen.getByLabelText('Values'), 'L{Enter}');
    await user.click(screen.getByRole('button', { name: 'Generate variants' }));
    expect(env.generate).toHaveBeenCalledWith({ productId: 'prod_1', options: [{ name: 'Size', values: ['S', 'M', 'L'] }] });
    expect(toast.success).toHaveBeenCalledWith('1 variants created, 2 kept');
    expect(screen.queryByLabelText('Option name')).not.toBeInTheDocument();
  });

  it("opens the options in the product's order, not the variants' sorted keys", async () => {
    const user = userEvent.setup();
    render(
      <ProductVariantsSection
        productId="prod_1"
        productPrice="40"
        currency="EUR"
        productOptions={[
          { name: 'Size', values: ['S', 'M'] },
          { name: 'Colour', values: ['Red'] },
        ]}
        canEdit
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit options' }));
    expect(screen.getAllByLabelText('Option name').map((input) => (input as HTMLInputElement).value)).toEqual([
      'Size',
      'Colour',
    ]);
  });

  it('keeps the options open when generating fails', async () => {
    env.generate.mockRejectedValue(new Error('At most 100 combinations'));
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Edit options' }));
    // The editor takes the button's place, so focus moves into it.
    expect(screen.getByLabelText('Option name')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Generate variants' }));
    expect(toast.error).toHaveBeenCalledWith('At most 100 combinations');
    expect(screen.getByLabelText('Option name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Option name')).not.toBeInTheDocument();
    // …and back to the button when it closes, not to the page.
    expect(screen.getByRole('button', { name: 'Edit options' })).toHaveFocus();
  });

  it('edits a variant in place and sends only what changed', async () => {
    env.update.mockResolvedValue({ data: {} });
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Edit variant S' }));
    const sku = screen.getByLabelText('SKU');
    await user.clear(sku);
    await user.type(sku, 'SHIRT-SMALL');
    await user.type(screen.getByLabelText('Price'), '39,95');
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Inactive' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(env.update).toHaveBeenCalledWith({
      productId: 'prod_1',
      variantId: 'var_1',
      data: { sku: 'SHIRT-SMALL', price: '39.95', status: 'inactive' },
    });
    expect(toast.success).toHaveBeenCalledWith('Variant updated');
    expect(screen.queryByLabelText('SKU')).not.toBeInTheDocument();
  });

  it('says so when the SKU or barcode is taken', async () => {
    env.update.mockRejectedValue(new ApiError('sku taken', 409));
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Edit variant S' }));
    await user.type(screen.getByLabelText('Barcode'), '123');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(toast.error).toHaveBeenCalledWith('Another product or variant already uses this SKU or barcode.');
    expect(screen.getByLabelText('Barcode')).toBeInTheDocument();
  });

  it('shows the server’s message for other failures', async () => {
    env.update.mockRejectedValue(new Error('Variant not found'));
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Edit variant S' }));
    await user.type(screen.getByLabelText('Barcode'), '123');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(toast.error).toHaveBeenCalledWith('Variant not found');
  });

  it('refuses a price that is not one, and closes without a request when nothing changed', async () => {
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Edit variant S' }));
    await user.type(screen.getByLabelText('Price'), 'ten');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/Enter a price such as 19.99/)).toBeInTheDocument();
    expect(env.update).not.toHaveBeenCalled();
    // Focus goes to the field in error, which carries its message as its description.
    const price = screen.getByLabelText('Price');
    expect(price).toHaveFocus();
    expect(price).toHaveAccessibleDescription(/Enter a price such as 19.99/);

    await user.clear(screen.getByLabelText('Price'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(env.update).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Price')).not.toBeInTheDocument();
  });

  it('cancels an edit, keeping focus with the variant', async () => {
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Edit variant S' }));
    expect(screen.getByLabelText('SKU')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('SKU')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit variant S' })).toHaveFocus();
  });

  it('leaves focus in the next form when another variant is edited', async () => {
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Edit variant S' }));
    await user.click(screen.getByRole('button', { name: 'Edit variant M' }));
    expect(screen.getByLabelText('SKU')).toHaveValue('SHIRT-M');
    expect(screen.getByLabelText('SKU')).toHaveFocus();
  });

  it('marks the product price a variant falls back to in words, not only in grey', () => {
    show();
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByTitle('Product price')).toHaveTextContent('Product price');
  });

  it('asks before deleting a variant', async () => {
    env.remove.mockResolvedValue(undefined);
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Delete variant S' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('"S" will be deleted.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(env.remove).toHaveBeenCalledWith({ productId: 'prod_1', variantId: 'var_1' });
    expect(toast.success).toHaveBeenCalledWith('Variant deleted');
  });

  it('says why a variant could not be deleted', async () => {
    env.remove.mockRejectedValue(new Error('Variant has orders'));
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Delete variant S' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(toast.error).toHaveBeenCalledWith('Variant has orders');
  });
});

describe('variantPatch', () => {
  const base = variant({ price: '10.00' });
  const values = { sku: 'SHIRT-S', barcode: '871000', price: '10.00', status: 'active' };

  it('is empty when nothing changed, "10" being the same price as "10.00"', () => {
    expect(variantPatch(base, values)).toEqual({});
    expect(variantPatch(base, { ...values, price: '10' })).toEqual({});
  });

  it('clears a blank SKU, barcode or price', () => {
    expect(variantPatch(base, { ...values, sku: ' ', barcode: '', price: '' })).toEqual({
      sku: null,
      barcode: null,
      price: null,
    });
    expect(variantPatch(variant({ price: '0.00' }), { ...values, price: '' })).toEqual({ price: null });
  });

  it('sets a first price, and refuses one that is not a price', () => {
    expect(variantPatch(variant(), { ...values, price: '0' })).toEqual({ price: '0' });
    expect(variantPatch(base, { ...values, price: '1.234' })).toBeNull();
  });
});
