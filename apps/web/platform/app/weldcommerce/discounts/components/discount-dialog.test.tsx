import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceDiscount, DiscountInput } from '@/hooks/queries/use-commerce-orders-queries';

// Big forms with many keystrokes: allow for a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const env = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  currency: 'EUR' as string | undefined,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCreateCommerceDiscount: () => ({ mutateAsync: env.create }),
  useUpdateCommerceDiscount: () => ({ mutateAsync: env.update }),
  useCommerceSettings: () => ({ data: env.currency ? { data: { defaultCurrency: env.currency } } : undefined }),
  useProductsByIds: (ids: string[]) => ids.map((id) => ({ data: { data: { id, name: `Product ${id}` } } })),
}));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useCommerceCategoryTree: () => ({
    isLoading: false,
    data: {
      data: [
        { id: 'cat_1', name: 'Shirts', depth: 0, children: [{ id: 'cat_2', name: 'Linen', depth: 1, children: [] }] },
      ],
    },
  }),
}));
vi.mock('@/components/objects/category/product-picker-dialog', () => ({
  ProductPickerDialog: ({ onConfirm, onOpenChange, existingIds }: { onConfirm: (ids: string[]) => void; onOpenChange: (open: boolean) => void; existingIds: string[] }) => (
    <div role="dialog" aria-label="picker">
      <span>existing:{existingIds.join(',')}</span>
      <button
        type="button"
        onClick={() => {
          onConfirm(['prod_1', 'prod_2']);
          onOpenChange(false);
        }}
      >
        pick two
      </button>
    </div>
  ),
}));

import { DiscountDialog } from './discount-dialog';

// Radix Select reads pointer capture and scrolls the chosen option into view; jsdom has neither.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.create.mockReset();
  env.create.mockResolvedValue({ data: { id: 'dsc_9' } });
  env.update.mockReset();
  env.update.mockResolvedValue({ data: {} });
  env.currency = 'EUR';
  toast.success.mockReset();
  toast.error.mockReset();
});

function setup(discount?: CommerceDiscount) {
  const onOpenChange = vi.fn();
  render(<DiscountDialog open onOpenChange={onOpenChange} discount={discount} />);
  return { onOpenChange, user: userEvent.setup() };
}

async function choose(user: ReturnType<typeof userEvent.setup>, select: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: select }));
  await user.click(await screen.findByRole('option', { name: option }));
}

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Name'), 'Spring sale');
  await user.type(screen.getByLabelText('Code'), 'SPRING');
  await user.type(screen.getByLabelText('Percentage'), '10');
}

const existing: CommerceDiscount = {
  id: 'dsc_1',
  name: 'Winter',
  description: 'Cold',
  code: 'WINTER',
  type: 'fixed_amount',
  value: '5.00',
  currency: 'EUR',
  maxDiscountAmount: null,
  appliesTo: 'categories',
  productIds: [],
  variantIds: ['var_1'],
  categoryIds: ['cat_2'],
  minimumSubtotal: '50.00',
  minimumQuantity: 2,
  usageLimit: 10,
  usageLimitPerCustomer: null,
  usageCount: 3,
  status: 'active',
  effectiveStatus: 'active',
  startsAt: null,
  endsAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

describe('DiscountDialog, a new discount', () => {
  it('creates a percentage code for everything', async () => {
    const { user, onOpenChange } = setup();
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create.mock.calls[0][0] as DiscountInput).toMatchObject({
      name: 'Spring sale',
      code: 'SPRING',
      type: 'percentage',
      value: '10',
      currency: null,
      appliesTo: 'all',
      productIds: [],
      categoryIds: [],
      status: 'active',
    });
    expect(toast.success).toHaveBeenCalledWith('Discount created');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('asks for what is missing and does not create', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Enter a value.')).toBeTruthy();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('keeps a percentage to 100 and a code to one word', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('Name'), 'Spring');
    await user.type(screen.getByLabelText('Code'), 'SPRING SALE');
    await user.type(screen.getByLabelText('Percentage'), '150');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('A percentage cannot be more than 100.')).toBeTruthy();
    expect(screen.getByText('A code cannot contain spaces.')).toBeTruthy();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('shows the currency of a fixed amount in the workspace default, and no value for free shipping', async () => {
    const { user } = setup();
    expect(screen.queryByLabelText('Currency')).toBeNull();
    await choose(user, 'Type', 'Fixed amount');
    expect(screen.getByLabelText('Amount')).toBeTruthy();
    expect(screen.getByLabelText('Currency')).toHaveProperty('value', 'EUR');
    await choose(user, 'Type', 'Free shipping');
    expect(screen.queryByLabelText('Amount')).toBeNull();
    expect(screen.queryByLabelText('Percentage')).toBeNull();
  });

  it('creates a free shipping code without a value', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('Name'), 'Free shipping');
    await user.type(screen.getByLabelText('Code'), 'SHIPFREE');
    await choose(user, 'Type', 'Free shipping');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create.mock.calls[0][0]).toMatchObject({ type: 'free_shipping', value: '0', currency: null });
  });

  it('shows a code that is already taken on the code field, and stays open', async () => {
    env.create.mockRejectedValue({ status: 409, body: { error: { code: 'CODE_TAKEN', message: 'taken', details: { field: 'code' } } } });
    const { user, onOpenChange } = setup();
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('This code is already in use.')).toBeTruthy();
    expect(screen.getByLabelText('Code').getAttribute('aria-invalid')).toBe('true');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows any other failure in a toast', async () => {
    env.create.mockRejectedValue(new Error('Server on fire'));
    const { user } = setup();
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server on fire'));
  });

  it('needs a product for a product code, takes them from the picker, and lets one be removed', async () => {
    const { user } = setup();
    await fillBasics(user);
    await choose(user, 'Applies to', 'Specific products');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Choose at least one product.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add products' }));
    await user.click(screen.getByRole('button', { name: 'pick two' }));
    expect(screen.getByText('Product prod_1')).toBeTruthy();
    expect(screen.getByText('Product prod_2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove Product prod_2' }));
    expect(screen.queryByText('Product prod_2')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create.mock.calls[0][0]).toMatchObject({ appliesTo: 'products', productIds: ['prod_1'], categoryIds: [] });
  });

  it('takes categories from a checklist of the tree', async () => {
    const { user } = setup();
    await fillBasics(user);
    await choose(user, 'Applies to', 'Specific categories');
    await user.click(screen.getByRole('checkbox', { name: 'Linen' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    expect(env.create.mock.calls[0][0]).toMatchObject({ appliesTo: 'categories', categoryIds: ['cat_2'], productIds: [] });
  });

  it('sends the limits and the dates it was given, and null for the ones left empty', async () => {
    const { user } = setup();
    await fillBasics(user);
    await user.type(screen.getByLabelText('Total uses'), '50');
    await user.type(screen.getByLabelText('Starts'), '2026-12-01T09:00');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(env.create).toHaveBeenCalled());
    const body = env.create.mock.calls[0][0] as DiscountInput;
    expect(body.usageLimit).toBe(50);
    expect(body.usageLimitPerCustomer).toBeNull();
    expect(body.minimumQuantity).toBeNull();
    expect(body.startsAt).toBe(new Date(2026, 11, 1, 9, 0).toISOString());
    expect(body.endsAt).toBeNull();
  });
});

describe('DiscountDialog, an existing discount', () => {
  it('is filled in from the discount', () => {
    setup(existing);
    expect(screen.getByRole('dialog', { name: 'Edit discount' })).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Winter');
    expect(screen.getByLabelText('Code')).toHaveProperty('value', 'WINTER');
    expect(screen.getByLabelText('Amount')).toHaveProperty('value', '5');
    expect(screen.getByLabelText('Minimum order amount')).toHaveProperty('value', '50.00');
    expect(screen.getByLabelText('Total uses')).toHaveProperty('value', '10');
    expect(screen.getByRole('checkbox', { name: 'Linen' }).getAttribute('data-state')).toBe('checked');
  });

  it('updates it, and clears a limit that was emptied', async () => {
    const { user, onOpenChange } = setup(existing);
    await user.clear(screen.getByLabelText('Total uses'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    const call = env.update.mock.calls[0][0] as { id: string; data: DiscountInput };
    expect(call.id).toBe('dsc_1');
    expect(call.data).toMatchObject({ code: 'WINTER', value: '5', usageLimit: null, minimumQuantity: 2, categoryIds: ['cat_2'] });
    expect(toast.success).toHaveBeenCalledWith('Discount updated');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
