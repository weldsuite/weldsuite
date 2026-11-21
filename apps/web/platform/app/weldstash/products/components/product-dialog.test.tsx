import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WeldstashProduct } from '@weldsuite/core-api-client/schemas/weldstash';

const mutations = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useCreateWeldstashProduct: () => ({ mutateAsync: mutations.create }),
  useUpdateWeldstashProduct: () => ({ mutateAsync: mutations.update }),
}));
const defaults = vi.hoisted(() => ({ currency: 'EUR' as string | null, salesTax: true, isLoading: false }));
vi.mock('../../lib/use-product-defaults', () => ({ useProductDefaults: () => defaults }));
vi.mock('./product-images-field', () => ({ ProductImagesField: () => null }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ProductDialog } from './product-dialog';

function product(overrides: Partial<WeldstashProduct> = {}): WeldstashProduct {
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

function open(existing?: WeldstashProduct) {
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

/** The optional fields, filled as a person typically would. */
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
  defaults.currency = 'EUR';
  defaults.salesTax = true;
  mutations.create.mockReset();
  mutations.update.mockReset();
  mutations.create.mockResolvedValue({ data: { id: 'prod_new' } });
  mutations.update.mockResolvedValue({ data: { id: 'prod_1' } });
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe('ProductDialog · VAT category', () => {
  it('does not ask for it in WeldStash', () => {
    open();
    expect(screen.queryByText('VAT category')).toBeNull();
  });

  it('asks for it in WeldCommerce, standard to begin with, and sends the one chosen', async () => {
    const user = userEvent.setup();
    render(<ProductDialog open onOpenChange={vi.fn()} showVatCategory />);
    const select = screen.getByRole('combobox', { name: 'VAT category' });
    expect(select).toHaveTextContent('Standard rate');
    await user.type(screen.getByLabelText('Name'), 'Book');
    await fillRequired(user);
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Reduced rate' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({ name: 'Book', vatCategory: 'reduced' });
  });

  it('shows the stored category when editing', () => {
    render(<ProductDialog open onOpenChange={vi.fn()} product={product({ vatCategory: 'zero' })} showVatCategory />);
    expect(screen.getByRole('combobox', { name: 'VAT category' })).toHaveTextContent('Zero rate (0%)');
  });
});

describe('ProductDialog · sales tax', () => {
  it('shows a new product as taxable with the default tax code', () => {
    open();
    expect(taxable()).toBeChecked();
    expect(taxCode()).toHaveTextContent('Default (general goods)');
    expect(screen.getByText(/WeldBooks invoices use this/)).toBeInTheDocument();
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

  it('hides the US sales tax fields when the workspace has no US entity, and sends none', async () => {
    defaults.salesTax = false;
    const user = userEvent.setup();
    open();
    expect(screen.queryByTestId('product-tax-fields')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Stroopwafels');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    const sent = mutations.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('taxable');
    expect(sent).not.toHaveProperty('taxClass');
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

describe('ProductDialog · optional fields and errors', () => {
  it('creates a product from a name alone: a blank SKU, cost price and low stock are not given', async () => {
    const user = userEvent.setup();
    const onOpenChange = open();
    await user.type(screen.getByLabelText('Name'), 'E2E Product A');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    const sent = mutations.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: 'E2E Product A', price: 0, currency: 'EUR' });
    expect(sent.sku).toBeUndefined();
    expect(sent.costPrice).toBeUndefined();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('prices a new product in the workspace currency, upper-casing a typed code', async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByLabelText('Currency')).toHaveValue('EUR');
    await user.type(screen.getByLabelText('Name'), 'Mug');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'gbp');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({ currency: 'GBP' });
  });

  it('says what is wrong instead of silently refusing to save', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Fill in this field.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Mug');
    // Typed key by key, a number box drops the lone minus sign; set the value at once.
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '-1' } });
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'EU');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Enter 0 or more.')).toBeInTheDocument();
    expect(screen.getByText('Use a three-letter currency code, such as EUR.')).toBeInTheDocument();
    expect(mutations.create).not.toHaveBeenCalled();
  });

  it('clears a stored SKU on an edit with an empty string', async () => {
    const user = userEvent.setup();
    open(product());
    await user.clear(screen.getByLabelText('SKU'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    const call = mutations.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toHaveProperty('sku', '');
  });
});
