import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProductSupplier } from '@weldsuite/app-api-client/schemas/product-suppliers';

const env = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  productParams: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useCreateProductSupplier: () => ({ mutateAsync: env.create, isPending: false }),
  useUpdateProductSupplier: () => ({ mutateAsync: env.update, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashSuppliers: () => ({
    data: {
      data: [
        { id: 'sup_1', name: 'Acme' },
        { id: 'sup_2', name: 'Zeta' },
      ],
    },
  }),
  useWeldstashProducts: (params: unknown) => {
    env.productParams.push(params);
    return {
      data: {
        data: [
          { id: 'prod_1', name: 'Widget', sku: 'W-1' },
          { id: 'prod_2', name: 'Gadget', sku: null },
        ],
      },
    };
  },
}));

import { ProductSupplierDialog } from './product-supplier-dialog';

function row(overrides: Partial<ProductSupplier> = {}): ProductSupplier {
  return {
    id: 'ps_1',
    productId: 'prod_1',
    variantId: null,
    supplierId: 'sup_1',
    supplierSku: 'AC-1',
    supplierProductName: null,
    unitCost: '12.5000',
    currency: 'EUR',
    leadTimeDays: 14,
    minOrderQty: null,
    orderMultiple: 6,
    isPreferred: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    supplierName: 'Acme',
    supplierCode: null,
    supplierCurrency: 'EUR',
    supplierLeadTimeDays: null,
    productName: 'Widget',
    productSku: 'W-1',
    ...overrides,
  };
}

type Props = Partial<React.ComponentProps<typeof ProductSupplierDialog>>;

function renderDialog(props: Props = {}) {
  const onOpenChange = vi.fn();
  render(<ProductSupplierDialog open onOpenChange={onOpenChange} {...props} />);
  return onOpenChange;
}

async function pick(user: ReturnType<typeof userEvent.setup>, trigger: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: trigger }));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.create.mockReset().mockResolvedValue({});
  env.update.mockReset().mockResolvedValue({});
  env.productParams.length = 0;
  env.toast.success.mockClear();
  env.toast.error.mockClear();
});

describe('ProductSupplierDialog linking from a product', () => {
  it('shows a supplier picker but no product picker, and links the chosen supplier with its terms', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog({ productId: 'prod_1' });
    expect(screen.queryByRole('combobox', { name: 'Product' })).not.toBeInTheDocument();
    await pick(user, 'Supplier', 'Acme');
    await user.type(screen.getByLabelText('Supplier SKU'), 'AC-9');
    await user.type(screen.getByLabelText('Unit cost'), '12.5');
    await user.type(screen.getByLabelText('Currency'), 'usd');
    await user.type(screen.getByLabelText('Lead time (days)'), '10');
    await user.clear(screen.getByLabelText('Order multiple'));
    await user.type(screen.getByLabelText('Order multiple'), '6');
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Link supplier' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create).toHaveBeenCalledWith({
      productId: 'prod_1',
      supplierId: 'sup_1',
      supplierSku: 'AC-9',
      unitCost: 12.5,
      currency: 'USD',
      leadTimeDays: 10,
      orderMultiple: 6,
      isPreferred: true,
    });
    expect(env.toast.success).toHaveBeenCalledWith('Supplier linked');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves out suppliers that are already linked', async () => {
    const user = userEvent.setup();
    renderDialog({ productId: 'prod_1', excludeIds: ['sup_1'] });
    await user.click(screen.getByRole('combobox', { name: 'Supplier' }));
    expect(await screen.findByRole('option', { name: 'Zeta' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Acme' })).not.toBeInTheDocument();
  });

  it('asks for a supplier and flags an invalid cost, and sends nothing', async () => {
    const user = userEvent.setup();
    renderDialog({ productId: 'prod_1' });
    await user.type(screen.getByLabelText('Unit cost'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Link supplier' }));
    expect(await screen.findAllByText(/Required|Check this value/)).not.toHaveLength(0);
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('Check this value')).toBeInTheDocument();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('shows the backend message and stays open when linking fails (already linked)', async () => {
    env.create.mockRejectedValue(new Error('This supplier is already linked'));
    const user = userEvent.setup();
    const onOpenChange = renderDialog({ productId: 'prod_1' });
    await pick(user, 'Supplier', 'Acme');
    await user.click(screen.getByRole('button', { name: 'Link supplier' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('This supplier is already linked'));
    expect(env.toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error has none', async () => {
    env.create.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    renderDialog({ productId: 'prod_1' });
    await pick(user, 'Supplier', 'Acme');
    await user.click(screen.getByRole('button', { name: 'Link supplier' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not save'));
  });

  it('closes on cancel', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog({ productId: 'prod_1' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ProductSupplierDialog linking from a supplier', () => {
  it('has a searchable product picker and no supplier picker, and links the chosen product', async () => {
    const user = userEvent.setup();
    renderDialog({ supplierId: 'sup_2' });
    expect(screen.queryByRole('combobox', { name: 'Supplier' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Search products…'), 'wid');
    await waitFor(() => expect(env.productParams.at(-1)).toEqual({ limit: 25, search: 'wid' }));
    await pick(user, 'Product', 'Widget (W-1)');
    await user.click(screen.getByRole('button', { name: 'Link supplier' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create.mock.calls[0][0]).toMatchObject({ productId: 'prod_1', supplierId: 'sup_2', orderMultiple: 1, isPreferred: false });
  });

  it('shows products without a SKU by name, and leaves out linked products', async () => {
    const user = userEvent.setup();
    renderDialog({ supplierId: 'sup_2', excludeIds: ['prod_1'] });
    await user.click(screen.getByRole('combobox', { name: 'Product' }));
    expect(await screen.findByRole('option', { name: 'Gadget' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Widget (W-1)' })).not.toBeInTheDocument();
  });

  it('asks for a product when none is chosen', async () => {
    const user = userEvent.setup();
    renderDialog({ supplierId: 'sup_2' });
    await user.click(screen.getByRole('button', { name: 'Link supplier' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(env.create).not.toHaveBeenCalled();
  });
});

describe('ProductSupplierDialog editing', () => {
  it('prefills the terms, locks the supplier, and saves the changes', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog({ row: row() });
    expect(screen.getByText('Edit supplier terms', { selector: 'h2, [data-slot="dialog-title"]' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Supplier' })).toBeDisabled();
    expect(screen.queryByRole('combobox', { name: 'Product' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Supplier SKU')).toHaveValue('AC-1');
    expect(screen.getByLabelText('Unit cost')).toHaveValue('12.5');
    expect(screen.getByLabelText('Order multiple')).toHaveValue('6');
    await user.clear(screen.getByLabelText('Lead time (days)'));
    await user.type(screen.getByLabelText('Lead time (days)'), '21');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update.mock.calls[0][0]).toMatchObject({ id: 'ps_1', data: { leadTimeDays: 21, unitCost: 12.5, currency: 'EUR', orderMultiple: 6 } });
    expect(env.create).not.toHaveBeenCalled();
    expect(env.toast.success).toHaveBeenCalledWith('Changes saved');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('clears an emptied optional field by sending null', async () => {
    const user = userEvent.setup();
    renderDialog({ row: row() });
    await user.clear(screen.getByLabelText('Supplier SKU'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update.mock.calls[0][0].data.supplierSku).toBeNull();
  });

  it('shows the error and stays open when the update fails', async () => {
    env.update.mockRejectedValue(new Error('Product not found'));
    const user = userEvent.setup();
    const onOpenChange = renderDialog({ row: row() });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Product not found'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('refuses an invalid lead time without calling the API', async () => {
    const user = userEvent.setup();
    renderDialog({ row: row() });
    await user.clear(screen.getByLabelText('Lead time (days)'));
    await user.type(screen.getByLabelText('Lead time (days)'), '999');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Check this value')).toBeInTheDocument();
    expect(env.update).not.toHaveBeenCalled();
  });
});
