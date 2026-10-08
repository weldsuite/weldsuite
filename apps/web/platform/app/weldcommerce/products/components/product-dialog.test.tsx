import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceProduct } from '@/hooks/queries/use-commerce-queries';

const mutations = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useCreateCommerceProduct: () => ({ mutateAsync: mutations.create }),
  useUpdateCommerceProduct: () => ({ mutateAsync: mutations.update }),
  useCommerceProduct: () => ({ data: undefined }),
}));
vi.mock('./product-images-field', () => ({ ProductImagesField: () => null }));
vi.mock('./product-sales-channels-editor', () => ({ ProductSalesChannelsEditor: () => null }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ProductDialog } from './product-dialog';

function product(overrides: Partial<CommerceProduct> = {}): CommerceProduct {
  return {
    id: 'prod_1',
    name: 'Linen shirt',
    slug: 'linen-shirt-abc123',
    sku: 'SHIRT-1',
    price: 40,
    costPrice: 12,
    currency: 'USD',
    status: 'active',
    lowStockThreshold: 5,
    trackInventory: true,
    taxable: true,
    taxClass: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function open(existing?: CommerceProduct) {
  const onOpenChange = vi.fn();
  render(<ProductDialog open onOpenChange={onOpenChange} product={existing} />);
  return onOpenChange;
}

const taxCode = () => screen.getByRole('combobox', { name: 'Tax code' });
const taxable = () => screen.getByRole('switch', { name: 'Taxable' });

async function pickTaxCode(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(taxCode());
  await user.click(await screen.findByRole('option', { name: label }));
}

/**
 * The product form's schema refuses an empty SKU and reads an empty number box
 * as NaN, so a create has to fill these before it can pass validation.
 */
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('SKU'), 'SKU-1');
  await user.type(screen.getByLabelText('Cost price'), '10');
  await user.type(screen.getByLabelText('Low stock at'), '5');
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  mutations.create.mockReset();
  mutations.update.mockReset();
  mutations.create.mockResolvedValue({ data: { id: 'prod_new' } });
  mutations.update.mockResolvedValue({ data: { id: 'prod_1' } });
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe('ProductDialog · sales tax', () => {
  it('shows a new product as taxable with the default tax code', () => {
    open();
    expect(taxable()).toBeChecked();
    expect(taxCode()).toHaveTextContent('Default (general goods)');
    expect(screen.getByText(/WeldBooks invoices and WeldCommerce orders use this/)).toBeInTheDocument();
  });

  it('sends no tax fields for a new product left at the defaults', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText('Name'), 'Widget');
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    const sent = mutations.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: 'Widget' });
    expect(sent).not.toHaveProperty('taxable');
    expect(sent).not.toHaveProperty('taxClass');
  });

  it('creates a product with a WeldBooks tax code', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText('Name'), 'Hosted app');
    await fillRequired(user);
    await pickTaxCode(user, 'Software as a service');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    const sent = mutations.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: 'Hosted app', taxClass: 'saas' });
    expect(sent).not.toHaveProperty('taxable');
  });

  it('creates a product that is not taxable, and disables the code while it is off', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText('Name'), 'Donation');
    await fillRequired(user);
    await user.click(taxable());
    expect(taxable()).not.toBeChecked();
    expect(taxCode()).toBeDisabled();
    expect(screen.getByText('Not used while the product is not taxable.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    const sent = mutations.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: 'Donation', taxable: false });
    expect(sent).not.toHaveProperty('taxClass');
  });

  it('creates a product with a custom provider code, normalising its case', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText('Name'), 'Cloud hosting');
    await fillRequired(user);
    await pickTaxCode(user, 'Custom provider code…');
    await user.type(screen.getByLabelText('Provider tax code'), 'sw054000');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({ name: 'Cloud hosting', taxClass: 'SW054000' });
  });

  it('refuses a custom code that is no Stripe or Avalara code, and saves once it is fixed', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText('Name'), 'Gadget');
    await fillRequired(user);
    await pickTaxCode(user, 'Custom provider code…');
    await user.type(screen.getByLabelText('Provider tax code'), 'reduced');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter a Stripe code/);
    expect(mutations.create).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Provider tax code'));
    await user.type(screen.getByLabelText('Provider tax code'), 'txcd_20030000');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({ taxClass: 'txcd_20030000' });
  });

  it('prefills an existing product and sends no tax fields when they are not changed', async () => {
    const user = userEvent.setup();
    open(product({ taxable: false, taxClass: 'clothing' }));
    expect(taxable()).not.toBeChecked();
    expect(taxCode()).toHaveTextContent('Clothing');

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Linen shirt XL');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    const call = mutations.update.mock.calls[0]?.[0] as { id: string; data: Record<string, unknown> };
    expect(call.id).toBe('prod_1');
    expect(call.data).toMatchObject({ name: 'Linen shirt XL' });
    expect(call.data).not.toHaveProperty('taxable');
    expect(call.data).not.toHaveProperty('taxClass');
  });

  it('sends only the tax code that changed on an edit', async () => {
    const user = userEvent.setup();
    open(product({ taxClass: 'clothing' }));
    await pickTaxCode(user, 'Groceries');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    const call = mutations.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({ taxClass: 'food_grocery' });
    expect(call.data).not.toHaveProperty('taxable');
  });

  it('turns an existing product to not taxable without touching its code', async () => {
    const user = userEvent.setup();
    open(product({ taxClass: 'saas' }));
    await user.click(taxable());
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    const call = mutations.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({ taxable: false });
    expect(call.data).not.toHaveProperty('taxClass');
  });

  it('prefills a stored provider code in the custom input', () => {
    open(product({ taxClass: 'SW054000' }));
    expect(taxCode()).toHaveTextContent('Custom provider code…');
    expect(screen.getByLabelText('Provider tax code')).toHaveValue('SW054000');
  });

  it('clears the code with null when the default is chosen', async () => {
    const user = userEvent.setup();
    open(product({ taxClass: 'saas' }));
    await pickTaxCode(user, 'Default (general goods)');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    const call = mutations.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toHaveProperty('taxClass', null);
  });

  it('shows a legacy tax class as the default and leaves it alone on save', async () => {
    const user = userEvent.setup();
    open(product({ taxClass: 'standard' }));
    expect(taxCode()).toHaveTextContent('Default (general goods)');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    const call = mutations.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).not.toHaveProperty('taxClass');
  });
});
