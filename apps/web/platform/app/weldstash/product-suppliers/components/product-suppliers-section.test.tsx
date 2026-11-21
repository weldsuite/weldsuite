import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProductSupplier } from '@weldsuite/app-api-client/schemas/product-suppliers';

const env = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  params: [] as unknown[],
  permissions: new Set<string>(),
  update: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useProductSuppliers: (params: unknown) => {
    env.params.push(params);
    return env.query;
  },
  useUpdateProductSupplier: () => ({ mutateAsync: env.update, isPending: false }),
  useDeleteProductSupplier: () => ({ mutateAsync: env.remove, isPending: false }),
  useCreateProductSupplier: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashSuppliers: () => ({ data: { data: [{ id: 'sup_9', name: 'Fresh Supplier' }] } }),
  useWeldstashProducts: () => ({ data: { data: [{ id: 'prod_9', name: 'Fresh Product', sku: null }] } }),
}));

import { ProductSuppliersSection } from './product-suppliers-section';

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
    minOrderQty: 20,
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

function result(partial: Record<string, unknown>) {
  env.query = { data: [], isLoading: false, isError: false, refetch: env.refetch, ...partial };
}

const ALL = ['suppliers:create', 'suppliers:update', 'suppliers:delete'];

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.params.length = 0;
  env.permissions = new Set(ALL);
  env.update.mockReset().mockResolvedValue({});
  env.remove.mockReset().mockResolvedValue({});
  env.refetch.mockReset();
  env.toast.success.mockClear();
  env.toast.error.mockClear();
  result({ data: [row()] });
});

describe('ProductSuppliersSection', () => {
  it('asks for the suppliers of a product, and for the products of a supplier', () => {
    const { unmount } = render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(env.params.at(-1)).toEqual({ productId: 'prod_1' });
    unmount();
    render(<ProductSuppliersSection side="supplier" supplierId="sup_1" />);
    expect(env.params.at(-1)).toEqual({ supplierId: 'sup_1' });
  });

  it('shows a spinner while loading', () => {
    result({ data: undefined, isLoading: true });
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(screen.queryByText('Suppliers')).not.toBeInTheDocument();
  });

  it('shows the error and retries on request', async () => {
    result({ data: undefined, isError: true, error: new Error('Boom') });
    const user = userEvent.setup();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(screen.getByText('Boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button'));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('falls back to a generic error message', () => {
    result({ data: undefined, isError: true, error: null });
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(screen.getByText('Could not load the product suppliers.')).toBeInTheDocument();
  });

  it('shows a product its suppliers with cost, lead time, minimum and pack size', () => {
    result({ data: [row({ isPreferred: true, variantId: 'var_1' })] });
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Preferred')).toBeInTheDocument();
    expect(screen.getByText('Variant')).toBeInTheDocument();
    expect(screen.getByText('AC-1')).toBeInTheDocument();
    expect(screen.getByText('€12.50 · 14 days lead time · minimum 20 · in packs of 6')).toBeInTheDocument();
  });

  it('shows a supplier its products, with the supplier defaults when the row has none', () => {
    result({
      data: [row({ leadTimeDays: null, supplierLeadTimeDays: 9, currency: null, minOrderQty: null, orderMultiple: 1, supplierSku: null })],
    });
    render(<ProductSuppliersSection side="supplier" supplierId="sup_1" />);
    expect(screen.getByText('Products', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText('W-1')).toBeInTheDocument();
    expect(screen.getByText('€12.50 · 9 days lead time')).toBeInTheDocument();
  });

  it('explains an empty product and an empty supplier differently', () => {
    result({ data: undefined });
    const { unmount } = render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(screen.getByText('No suppliers yet')).toBeInTheDocument();
    unmount();
    render(<ProductSuppliersSection side="supplier" supplierId="sup_1" />);
    expect(screen.getByText('No products yet')).toBeInTheDocument();
  });

  it('makes a supplier preferred, and offers it only on a row that is not', async () => {
    result({ data: [row({ id: 'ps_1' }), row({ id: 'ps_2', supplierName: 'Zeta', isPreferred: true })] });
    const user = userEvent.setup();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(screen.getAllByRole('button', { name: 'Make preferred' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Make preferred' }));
    await waitFor(() => expect(env.update).toHaveBeenCalledWith({ id: 'ps_1', data: { isPreferred: true } }));
    expect(env.toast.success).toHaveBeenCalledWith('Preferred supplier changed');
  });

  it('shows the error when making preferred fails', async () => {
    env.update.mockRejectedValue(new Error('Nope'));
    const user = userEvent.setup();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    await user.click(screen.getByRole('button', { name: 'Make preferred' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Nope'));
  });

  it('falls back to a generic message when making preferred fails without one', async () => {
    env.update.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    await user.click(screen.getByRole('button', { name: 'Make preferred' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not save'));
  });

  it('removes a link after confirming', async () => {
    const user = userEvent.setup();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Acme will no longer be linked.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(env.remove).toHaveBeenCalledWith('ps_1'));
    expect(env.toast.success).toHaveBeenCalledWith('Link removed');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the error when removing fails', async () => {
    env.remove.mockRejectedValue(new Error('In use'));
    const user = userEvent.setup();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('In use'));
    expect(env.toast.success).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when removing fails without one', async () => {
    env.remove.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not remove the link'));
  });

  it('opens the edit dialog on the row, and the add dialog without the linked suppliers', async () => {
    const user = userEvent.setup();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Supplier SKU')).toHaveValue('AC-1');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add supplier' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Link supplier', { selector: 'h2, [data-slot="dialog-title"]' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('labels the add button "Add product" on a supplier', () => {
    render(<ProductSuppliersSection side="supplier" supplierId="sup_1" />);
    expect(screen.getByRole('button', { name: 'Add product' })).toBeInTheDocument();
  });

  it('hides every change control without permission', () => {
    env.permissions = new Set();
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    for (const name of ['Add supplier', 'Make preferred', 'Edit', 'Remove']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('shows only the controls the user may use', () => {
    env.permissions = new Set(['suppliers:update']);
    render(<ProductSuppliersSection side="product" productId="prod_1" />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add supplier' })).not.toBeInTheDocument();
  });
});
