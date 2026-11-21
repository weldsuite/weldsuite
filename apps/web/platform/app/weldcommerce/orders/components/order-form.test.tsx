import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order, OrderInput, OrderQuote } from '@/hooks/queries/use-commerce-orders-queries';
import type { LineValues } from '../../lib/order-form';

// Big forms with many keystrokes: allow for a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const env = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  quote: undefined as unknown,
  quoteInputs: [] as unknown[],
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCreateCommerceOrder: () => ({ mutateAsync: env.create }),
  useUpdateCommerceOrder: () => ({ mutateAsync: env.update }),
  useOrderQuote: (input: unknown) => {
    env.quoteInputs.push(input);
    return { data: input && env.quote ? { data: env.quote } : undefined, isFetching: false, isError: false };
  },
}));
vi.mock('./order-line-picker-dialog', () => ({
  OrderLinePickerDialog: ({ onPick, onOpenChange }: { onPick: (line: LineValues) => void; onOpenChange: (open: boolean) => void }) => (
    <div role="dialog">
      <button
        type="button"
        onClick={() => {
          onPick({ productId: 'prod_1', variantId: null, sku: 'COAT', name: 'Wool coat', variantName: null, quantity: 1, unitPrice: '' });
          onOpenChange(false);
        }}
      >
        pick coat
      </button>
    </div>
  ),
}));
vi.mock('@/components/objects/_shared/record-selection-modal', () => ({
  RecordSelectionModal: ({ kind, onSelectRecord }: { kind: string; onSelectRecord: (record: unknown) => void }) => (
    <div role="dialog">
      <button
        type="button"
        onClick={() =>
          onSelectRecord(
            kind === 'company'
              ? { id: 'comp_1', kind: 'company', displayName: 'Acme BV', email: 'info@acme.example' }
              : { id: 'per_1', kind: 'person', displayName: 'Ada Lovelace', email: 'ada@acme.example' },
          )
        }
      >
        pick {kind}
      </button>
    </div>
  ),
}));

import { OrderForm } from './order-form';

const quote: OrderQuote = {
  currency: 'EUR',
  lines: [
    {
      variantId: null,
      productId: 'prod_1',
      sku: 'COAT',
      name: 'Wool coat',
      variantName: null,
      quantity: 1,
      unitPrice: '120.00',
      discountAmount: '0.00',
      total: '120.00',
      problem: null,
    },
  ],
  subtotal: '120.00',
  discountTotal: '0.00',
  shippingTotal: '0.00',
  taxTotal: '0.00',
  total: '120.00',
  discount: null,
  discountProblem: null,
};

function setup(props: { order?: Order } = {}) {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(<OrderForm defaultCurrency="EUR" onSaved={onSaved} onCancel={onCancel} {...props} />);
  return { onSaved, onCancel, user: userEvent.setup() };
}

async function addCoat(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Add product' }));
  await user.click(screen.getByRole('button', { name: 'pick coat' }));
}

beforeEach(() => {
  env.create.mockReset();
  env.create.mockResolvedValue({ data: { id: 'ord_9', orderNumber: 'WC-1009' } });
  env.update.mockReset();
  env.update.mockResolvedValue({ data: {} });
  env.quote = quote;
  env.quoteInputs = [];
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('OrderForm, a new order', () => {
  it('starts empty, with the default currency, confirming on create, and asks for an item before a total', () => {
    setup();
    expect(screen.getByLabelText('Currency')).toHaveProperty('value', 'EUR');
    expect(screen.getByRole('switch', { name: 'Confirm the order straight away' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/No items yet/)).toBeTruthy();
    expect(screen.getByText('Add an item to see the total.')).toBeTruthy();
    expect(env.quoteInputs.at(-1)).toBeNull();
  });

  it('prices the order through the quote once an item is added, and shows its total and the catalogue price', async () => {
    const { user } = setup();
    await addCoat(user);
    expect(env.quoteInputs.at(-1)).toMatchObject({ currency: 'EUR', items: [{ productId: 'prod_1', quantity: 1 }] });
    expect(screen.getByText('Wool coat')).toBeTruthy();
    expect(screen.getByLabelText('Unit price').getAttribute('placeholder')).toBe('120.00');
    expect(screen.getByText('Total', { selector: 'dt' }).nextElementSibling?.textContent).toContain('120.00');
  });

  it('adds one more to the quantity when the same product is picked again', async () => {
    const { user } = setup();
    await addCoat(user);
    await addCoat(user);
    expect(screen.getAllByLabelText('Quantity')).toHaveLength(1);
    expect(screen.getByLabelText('Quantity')).toHaveProperty('value', '2');
  });

  it('says in words what is wrong with a line and with the discount code', async () => {
    env.quote = {
      ...quote,
      lines: [{ ...quote.lines[0], problem: 'NO_PRICE' }],
      discountProblem: 'EXPIRED',
    };
    const { user } = setup();
    await addCoat(user);
    await user.type(screen.getByLabelText('Discount code'), 'OLD');
    expect(screen.getByRole('alert').textContent).toBe('This item has no price. Enter one.');
    expect(screen.getByText('This code has expired.')).toBeTruthy();
  });

  it('fills the name and email from the company and the contact that are picked', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Choose a company' }));
    await user.click(screen.getByRole('button', { name: 'pick company' }));
    expect(screen.getByText('Acme BV')).toBeTruthy();
    expect(screen.getAllByLabelText('Email')[0]).toHaveProperty('value', 'info@acme.example');

    await user.click(screen.getByRole('button', { name: 'Choose a contact' }));
    await user.click(screen.getByRole('button', { name: 'pick person' }));
    expect(screen.getByLabelText('Customer name')).toHaveProperty('value', 'Ada Lovelace');
    // The email was already filled in by the company.
    expect(screen.getAllByLabelText('Email')[0]).toHaveProperty('value', 'info@acme.example');
  });

  it('creates the order with the company, free line, shipping and code, and hands over the new id', async () => {
    const { user, onSaved } = setup();
    await user.click(screen.getByRole('button', { name: 'Choose a company' }));
    await user.click(screen.getByRole('button', { name: 'pick company' }));
    await user.click(screen.getByRole('button', { name: 'Add free line' }));
    await user.type(screen.getByLabelText('Description'), 'Installation');
    await user.type(screen.getByLabelText('Unit price'), '75.00');
    await user.type(screen.getByLabelText('Shipping'), '6.95');
    await user.type(screen.getByLabelText('Discount code'), 'SPRING');
    await user.click(screen.getByRole('switch', { name: 'Confirm the order straight away' }));
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(env.create).toHaveBeenCalled());
    const body = env.create.mock.calls[0][0] as OrderInput;
    expect(body).toMatchObject({
      companyId: 'comp_1',
      currency: 'EUR',
      items: [{ name: 'Installation', quantity: 1, unitPrice: '75.00' }],
      shippingTotal: '6.95',
      discountCode: 'SPRING',
      status: 'pending',
    });
    expect(toast.success).toHaveBeenCalledWith('Order WC-1009 created');
    expect(onSaved).toHaveBeenCalledWith('ord_9');
  });

  it('does not create an order without an item, and says so', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText('Add at least one item.')).toBeTruthy();
    expect(env.create).not.toHaveBeenCalled();
    // No field to focus: focus goes to the button that fixes it.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add product' }));
  });

  it('asks a free line for its description and price', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Add free line' }));
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText('Describe this line.')).toBeTruthy();
    expect(screen.getByText('Enter a price for this line.')).toBeTruthy();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('shows a refused discount code on the code field', async () => {
    env.create.mockRejectedValue({
      status: 409,
      body: { error: { code: 'DISCOUNT_NOT_APPLICABLE', message: 'no', details: { reason: 'USAGE_LIMIT' } } },
    });
    const { user, onSaved } = setup();
    await addCoat(user);
    await user.type(screen.getByLabelText('Discount code'), 'GONE');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText('This code has been used up.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('words any other failure in a toast', async () => {
    env.create.mockRejectedValue(new Error('Server on fire'));
    const { user } = setup();
    await addCoat(user);
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server on fire'));
  });

  it('removes a line', async () => {
    const { user } = setup();
    await addCoat(user);
    await user.click(screen.getByRole('button', { name: 'Remove Wool coat' }));
    expect(screen.getByText(/No items yet/)).toBeTruthy();
  });

  it('cancels', async () => {
    const { user, onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord_1',
    orderNumber: 'WC-1001',
    currency: 'EUR',
    companyId: 'comp_1',
    companyName: 'Acme BV',
    personId: null,
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@acme.example',
    customerPhone: null,
    shippingTotal: '5.00',
    discountCode: null,
    billingAddress: { city: 'Utrecht' },
    shippingAddress: null,
    customerReference: 'PO-1',
    customerNote: null,
    internalNote: null,
    editable: true,
    items: [
      { id: 'item_1', productId: 'prod_1', variantId: null, sku: 'COAT', name: 'Wool coat', variantName: null, quantity: 1, unitPrice: '120.00' },
    ],
    ...overrides,
  } as unknown as Order;
}

describe('OrderForm, editing an order', () => {
  it('starts from the order, locks the currency and does not offer to confirm', () => {
    setup({ order: order() });
    expect(screen.getByLabelText('Customer name')).toHaveProperty('value', 'Ada Lovelace');
    expect(screen.getByLabelText('Currency')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('patches the order with its item ids and hands back its id', async () => {
    const { user, onSaved } = setup({ order: order() });
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(env.update).toHaveBeenCalled());
    const call = env.update.mock.calls[0][0] as { id: string; data: Record<string, unknown> };
    expect(call.id).toBe('ord_1');
    expect(call.data.items).toEqual([{ id: 'item_1', productId: 'prod_1', quantity: 3, unitPrice: '120.00' }]);
    expect(call.data.customerReference).toBe('PO-1');
    expect(toast.success).toHaveBeenCalledWith('Order updated');
    expect(onSaved).toHaveBeenCalledWith('ord_1');
  });

  it('locks the customer, items, shipping and code of an order that is no longer editable, and patches only the rest', async () => {
    const { user } = setup({ order: order({ editable: false }) });
    expect(screen.getByText(/can no longer change/)).toBeTruthy();
    expect(screen.getByLabelText('Customer name')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Discount code')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Shipping')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Quantity')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Add product' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove Wool coat/ })).toBeNull();
    // No price check for an order that cannot be repriced.
    expect(env.quoteInputs.every((input) => input === null)).toBe(true);

    await user.type(screen.getByLabelText('Internal note'), 'Called the buyer');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    const data = (env.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(
      ['billingAddress', 'customerNote', 'customerReference', 'internalNote', 'shippingAddress'].sort(),
    );
    expect(data.internalNote).toBe('Called the buyer');
  });

  it('keeps the dialog open and words a refusal from the server', async () => {
    env.update.mockRejectedValue({ status: 409, body: { error: { code: 'ORDER_NOT_EDITABLE', message: 'x' } } });
    const { user, onSaved } = setup({ order: order() });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This order can no longer be changed.'));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('the address fields', () => {
  it('copy the billing address to the shipping address on request', async () => {
    const { user } = setup();
    const billing = screen.getByRole('group', { name: 'Billing address' });
    await user.type(within(billing).getByLabelText('City'), 'Utrecht');
    await user.type(within(billing).getByLabelText('Country code'), 'nl');
    await user.click(screen.getByRole('button', { name: 'Use as shipping address' }));
    const shipping = screen.getByRole('group', { name: 'Shipping address' });
    expect(within(shipping).getByLabelText('City')).toHaveProperty('value', 'Utrecht');
    expect(within(shipping).getByLabelText('Country code')).toHaveProperty('value', 'nl');
  });

  it('are plain text inputs with autofill off, since they hold a customer, not the staff member', () => {
    setup();
    const billing = screen.getByRole('group', { name: 'Billing address' });
    const postal = within(billing).getByLabelText('Postal code');
    expect(postal.getAttribute('autocomplete')).toBe('off');
    expect(within(billing).getByLabelText('Email').getAttribute('type')).toBe('email');
    expect(within(billing).getByLabelText('Phone').getAttribute('type')).toBe('tel');
  });
});
