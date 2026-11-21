import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';

interface StubTab {
  id: string;
  label: string;
  count?: number;
}
interface StubField {
  label: string;
  value: ReactNode;
}

const env = vi.hoisted(() => ({
  order: null as unknown,
  open: vi.fn(),
  isLoading: false,
  error: null as Error | null,
  canUpdate: true,
  recalculate: vi.fn(),
}));

vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: env.open }) }));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCommerceOrder: () => ({
    data: env.order ? { data: env.order } : undefined,
    isLoading: env.isLoading,
    error: env.error,
  }),
  useRecalculateCommerceOrderTax: () => ({ mutateAsync: env.recalculate, isPending: false }),
}));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissionsMaybe: () => ({ can: () => env.canUpdate }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./order-actions', () => ({ OrderActions: ({ order }: { order: Order }) => <div data-testid="actions">{order.orderNumber}</div> }));
vi.mock('@/components/objects/_shared/simple-object-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/objects/_shared/simple-object-panel')>()),
  SimpleObjectPanel: ({
    tabs,
    renderTab,
    fields,
    extras,
    statusBadges,
    title,
    subtitle,
    openHref,
  }: {
    tabs: StubTab[];
    renderTab: (tabId: string) => ReactNode;
    fields: StubField[];
    extras?: ReactNode;
    statusBadges?: ReactNode;
    title?: string;
    subtitle?: string;
    openHref?: string;
  }) => (
    <div>
      <h1>{title}</h1>
      <p data-testid="subtitle">{subtitle}</p>
      <a data-testid="open-href" href={openHref}>
        open
      </a>
      <div data-testid="badges">{statusBadges}</div>
      {fields
        .filter((field) => field.value !== null && field.value !== undefined && field.value !== '')
        .map((field) => (
          <div key={field.label} data-testid={`field-${field.label}`}>
            {field.label}: {field.value}
          </div>
        ))}
      <div data-testid="extras">{extras}</div>
      {tabs.map((tab) => (
        <section key={tab.id} data-testid={`tab-${tab.id}`}>
          <h2>
            {tab.label}
            {tab.count ? ` (${tab.count})` : ''}
          </h2>
          {renderTab(tab.id)}
        </section>
      ))}
    </div>
  ),
}));

import { OrderPanel } from './order-panel';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord_1',
    orderNumber: 'WC-1001',
    status: 'confirmed',
    paymentStatus: 'pending',
    fulfillmentStatus: 'partial',
    approvalStatus: 'not_required',
    source: 'manual',
    channelId: null,
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.com',
    personId: null,
    companyId: 'comp_1',
    companyName: 'Acme',
    currency: 'EUR',
    total: '125.00',
    itemCount: 2,
    totalQuantity: 5,
    placedAt: '2026-11-20T10:00:00.000Z',
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    items: [
      {
        id: 'item_1',
        productId: 'prod_1',
        variantId: null,
        sku: 'SH-1',
        name: 'Linen shirt',
        variantName: 'M',
        imageUrl: null,
        quantity: 3,
        fulfilledQuantity: 2,
        unitPrice: '30.00',
        discountAmount: '0.00',
        taxAmount: '0.00',
        taxRate: null,
        vatCategory: null,
        total: '90.00',
      },
      {
        id: 'item_2',
        productId: null,
        variantId: null,
        sku: null,
        name: 'Installation',
        variantName: null,
        imageUrl: null,
        quantity: 2,
        fulfilledQuantity: 0,
        unitPrice: '17.50',
        discountAmount: '0.00',
        taxAmount: '0.00',
        taxRate: null,
        vatCategory: null,
        total: '35.00',
      },
    ],
    subtotal: '130.00',
    discountTotal: '10.00',
    shippingTotal: '5.00',
    taxTotal: '0.00',
    pricesIncludeTax: false,
    discountCode: 'SPRING',
    discountId: 'dsc_1',
    billingAddress: { name: 'Ada Lovelace', line1: 'Dam 1', postalCode: '1012 JS', city: 'Amsterdam', country: 'NL' },
    shippingAddress: null,
    customerPhone: null,
    customerReference: 'PO-77',
    customerNote: 'Leave at the door',
    internalNote: null,
    destinationCountry: null,
    buyerVatNumber: null,
    vatTreatment: null,
    viesUnavailable: false,
    vatRelief: '0.00',
    taxLines: [],
    paymentMethod: null,
    paymentReference: null,
    paidAt: null,
    cancelledAt: null,
    cancelReason: null,
    completedAt: null,
    externalOrderId: 'SHOP-9',
    tags: [],
    invoice: { id: 'inv_1', number: 'INV-2026-0007', status: 'sent' },
    editable: true,
    cancellable: true,
    ...overrides,
  };
}

const props = { id: 'ord_1', isOpen: true, onClose: vi.fn() };

beforeEach(() => {
  env.order = order();
  env.isLoading = false;
  env.error = null;
  env.open.mockReset();
  env.canUpdate = true;
  env.recalculate.mockReset();
  env.recalculate.mockResolvedValue({});
});

describe('OrderPanel', () => {
  it('titles the panel with the order number and the company, and links to the order on the list', () => {
    render(<OrderPanel {...props} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('WC-1001');
    expect(screen.getByTestId('subtitle').textContent).toBe('Acme');
    expect(screen.getByTestId('open-href').getAttribute('href')).toBe('/weldcommerce/orders?stack=order:ord_1');
  });

  it('shows the order, payment and fulfilment statuses', () => {
    render(<OrderPanel {...props} />);
    const badges = within(screen.getByTestId('badges'));
    expect(badges.getByText('Confirmed')).toBeTruthy();
    expect(badges.getByText('Unpaid')).toBeTruthy();
    expect(badges.getByText('Partially fulfilled')).toBeTruthy();
    expect(badges.queryByText('No approval needed')).toBeNull();
  });

  it('shows an approval status that is not the default', () => {
    env.order = order({ approvalStatus: 'pending' });
    render(<OrderPanel {...props} />);
    expect(within(screen.getByTestId('badges')).getByText('Awaiting approval')).toBeTruthy();
  });

  it('lists the customer, reference, source, external id and only the fields that have a value', () => {
    render(<OrderPanel {...props} />);
    expect(screen.getByTestId('field-Customer').textContent).toContain('Ada Lovelace');
    expect(screen.getByTestId('field-Customer reference').textContent).toContain('PO-77');
    expect(screen.getByTestId('field-Source').textContent).toContain('Manual');
    expect(screen.getByTestId('field-External order').textContent).toContain('SHOP-9');
    expect(screen.queryByTestId('field-Paid')).toBeNull();
    expect(screen.queryByTestId('field-Reason')).toBeNull();
  });

  it('shows the totals with the discount code, and leaves out tax and discount rows that are zero', () => {
    render(<OrderPanel {...props} />);
    const extras = within(screen.getByTestId('extras'));
    expect(extras.getByText('Discount (SPRING)')).toBeTruthy();
    expect(extras.getByText('Subtotal')).toBeTruthy();
    expect(extras.queryByText('Tax')).toBeNull();
    expect(extras.getByText('Total').parentElement?.textContent).toContain('125.00');
  });

  it('says how the VAT was worked out, per rate, and offers to recalculate while the order is editable', async () => {
    env.order = order({
      vatTreatment: 'oss',
      destinationCountry: 'DE',
      pricesIncludeTax: true,
      buyerVatNumber: null,
      taxTotal: '19.96',
      taxLines: [{ rate: '19.00', base: '105.04', amount: '19.96' }],
    });
    const user = userEvent.setup();
    render(<OrderPanel {...props} />);
    const extras = within(screen.getByTestId('extras'));
    expect(extras.getByText(/One-Stop Shop.*VAT at the rate of DE/)).toBeTruthy();
    expect(extras.getByText('Prices include VAT')).toBeTruthy();
    expect(extras.getByText('19% on €105.04', { exact: false })).toBeTruthy();
    expect(extras.queryByText(/VIES/)).toBeNull();
    await user.click(extras.getByRole('button', { name: 'Recalculate VAT' }));
    expect(env.recalculate).toHaveBeenCalledWith('ord_1');
  });

  it('warns when VIES was unavailable, and locks the VAT of an order that can no longer be edited', () => {
    env.order = order({ vatTreatment: 'oss', destinationCountry: 'DE', viesUnavailable: true, editable: false });
    render(<OrderPanel {...props} />);
    const extras = within(screen.getByTestId('extras'));
    expect(extras.getByText(/VIES was unavailable/)).toBeTruthy();
    expect(extras.queryByRole('button', { name: 'Recalculate VAT' })).toBeNull();
    expect(extras.getByText(/The VAT is locked/)).toBeTruthy();
  });

  it('shows no recalculate button without orders:update, and says an imported order keeps the store’s tax', () => {
    env.canUpdate = false;
    env.order = order({ vatTreatment: 'oss', destinationCountry: 'DE' });
    const { unmount } = render(<OrderPanel {...props} />);
    expect(screen.queryByRole('button', { name: 'Recalculate VAT' })).toBeNull();
    unmount();
    env.canUpdate = true;
    env.order = order({ vatTreatment: 'imported' });
    render(<OrderPanel {...props} />);
    expect(screen.getByText(/the store’s own tax stands/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Recalculate VAT' })).toBeNull();
  });

  it('shows no VAT calculated for an order from before VAT', () => {
    render(<OrderPanel {...props} />);
    expect(screen.getByText('No VAT was calculated for this order.')).toBeTruthy();
  });

  it('shows the fulfilment hint with how many items are fulfilled', () => {
    render(<OrderPanel {...props} />);
    const extras = within(screen.getByTestId('extras'));
    expect(extras.getByText(/WeldStash/)).toBeTruthy();
    expect(extras.getByText(/2 of 5 fulfilled/)).toBeTruthy();
  });

  it('shows the billing address and says when the shipping address is missing', () => {
    render(<OrderPanel {...props} />);
    const extras = within(screen.getByTestId('extras'));
    expect(extras.getByText('1012 JS Amsterdam')).toBeTruthy();
    expect(extras.getByText('No address.')).toBeTruthy();
    expect(extras.getByText('Leave at the door')).toBeTruthy();
  });

  it('opens the WeldBooks invoice, stacked on the order', async () => {
    const user = userEvent.setup();
    render(<OrderPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Invoice INV-2026-0007' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_1', stack: true });
  });

  it('shows no invoice section for an order without an invoice', () => {
    env.order = order({ invoice: null });
    render(<OrderPanel {...props} />);
    expect(screen.queryByRole('button', { name: /Invoice/ })).toBeNull();
  });

  it('lists the items with their quantity, price and fulfilled quantity on the Items tab', () => {
    render(<OrderPanel {...props} />);
    expect(screen.getByRole('heading', { name: 'Items (2)' })).toBeTruthy();
    const items = within(screen.getByTestId('tab-items'));
    expect(items.getByText('Linen shirt')).toBeTruthy();
    expect(items.getByText(/SH-1 · 3 × .*30\.00 · 2 of 3 fulfilled/)).toBeTruthy();
    expect(items.getByText(/0 of 2 fulfilled/)).toBeTruthy();
  });

  it('renders the actions of the order', () => {
    render(<OrderPanel {...props} />);
    expect(screen.getByTestId('actions').textContent).toBe('WC-1001');
  });
});
