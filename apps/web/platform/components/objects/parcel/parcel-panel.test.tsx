import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { Parcel, ParcelDetail, ParcelStatusEvent } from '@weldsuite/app-api-client/schemas/shipping';

interface StubField {
  label: string;
  value: string | null | undefined;
}
interface StubPanelProps {
  title?: string;
  subtitle?: string;
  isLoading: boolean;
  hasError?: boolean;
  hasData?: boolean;
  fields?: StubField[];
  statusBadges?: ReactNode;
  extras?: ReactNode;
}
interface MutationOptions {
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  parcel: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  refresh: { mutate: vi.fn(), isPending: false },
  createReturn: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  useParcel: () => ({ data: env.parcel, isLoading: env.isLoading, error: env.error }),
  useRefreshTracking: () => env.refresh,
  useCreateReturnLabel: () => env.createReturn,
}));
vi.mock('@/app/weldstash/shipping/components/parcel-file-buttons', () => ({
  ParcelFileButtons: ({ parcelId, kind, fileName }: { parcelId: string; kind: string; fileName?: string }) => (
    <span data-testid={`files-${kind}-${parcelId}`}>{fileName}</span>
  ),
}));
vi.mock('@/app/weldstash/shipping/components/shipping-error-notice', () => ({
  ShippingErrorNotice: ({ title }: { title: string }) => <div role="alert">{title}</div>,
}));
vi.mock('@/components/objects/_shared/simple-object-panel', () => ({
  SectionHeader: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  SimpleObjectPanel: ({ title, subtitle, isLoading, hasError, hasData, fields, statusBadges, extras }: StubPanelProps) => (
    <div>
      <p data-testid="state">{`${isLoading}|${hasError}|${hasData}`}</p>
      <h1>{title}</h1>
      <p data-testid="subtitle">{subtitle}</p>
      <div data-testid="badges">{statusBadges}</div>
      <dl>
        {(fields ?? []).map((field) => (
          <div key={field.label} data-testid={`field-${field.label}`}>
            {field.value}
          </div>
        ))}
      </dl>
      <div data-testid="extras">{extras}</div>
    </div>
  ),
}));

import { ParcelPanel } from './parcel-panel';

const t = en.weldstash.shipping.panel;
const props = { id: 'parcel_1' } as React.ComponentProps<typeof ParcelPanel>;

function parcel(over: Partial<ParcelDetail> = {}): ParcelDetail {
  return {
    id: 'parcel_1',
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
    status: 'in_transit',
    statusHistory: [],
    trackingNumber: '3SABCD123',
    trackingUrl: 'https://track.example.com/3SABCD123',
    carrierId: 'car_1',
    carrierName: 'PostNL',
    carrierCode: 'postnl',
    serviceType: 'Standard',
    carrierReference: null,
    colloNumber: 1,
    pickListId: null,
    shipmentId: null,
    orderId: 'ord_1',
    orderNumber: 'SO-1001',
    referenceNumber: null,
    recipientName: 'Ann Archer',
    recipientCompany: 'Archer BV',
    recipientEmail: null,
    recipientPhone: null,
    recipientAddress: { street: 'Dorpsstraat', houseNumber: '12', houseNumberSuffix: 'b', postalCode: '1234 AB', city: 'Utrecht', country: 'NL' },
    senderName: null,
    senderCompany: null,
    senderAddress: null,
    weight: '1.5',
    dimensions: null,
    servicePoint: { id: 'sp_1', name: 'Kiosk Centrum' },
    shippingCost: { contract: 'weld', credits: 4 },
    labelUrl: null,
    labelFormat: 'pdf',
    customsFormUrl: null,
    customsInfo: null,
    isReturn: false,
    returnForParcelId: null,
    returnTrackingNumber: null,
    returnLabelUrl: null,
    shippedAt: '2026-11-02',
    estimatedDeliveryDate: '2026-11-04',
    actualDeliveryDate: null,
    lastScanDate: '2026-11-03T08:30:00Z',
    lastScanLocation: 'Utrecht hub',
    trackingNextCheckAt: null,
    returnParcels: [],
    ...over,
  };
}

function setParcel(over: Partial<ParcelDetail> = {}) {
  env.parcel = parcel(over);
}

beforeEach(() => {
  env.allowed = new Set();
  env.parcel = undefined;
  env.isLoading = false;
  env.error = null;
  env.refresh = { mutate: vi.fn(), isPending: false };
  env.createReturn = { mutate: vi.fn(), isPending: false, isError: false, error: null };
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ParcelPanel', () => {
  it('passes the loading and error state on and falls back to the generic title without data', () => {
    env.isLoading = true;
    env.error = new Error('boom');
    render(<ParcelPanel {...props} />);
    expect(screen.getByTestId('state')).toHaveTextContent('true|true|false');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t.title);
    expect(screen.getByTestId('extras')).toBeEmptyDOMElement();
  });

  it('shows the details of the parcel as fields, with the tracking number as title', () => {
    setParcel();
    render(<ParcelPanel {...props} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('3SABCD123');
    expect(screen.getByTestId('subtitle')).toHaveTextContent('PostNL · SO-1001');
    expect(screen.getByTestId(`field-${t.carrier}`)).toHaveTextContent('PostNL');
    expect(screen.getByTestId(`field-${t.recipient}`)).toHaveTextContent('Archer BV · Ann Archer');
    expect(screen.getByTestId(`field-${t.address}`)).toHaveTextContent('Dorpsstraat 12b, 1234 AB Utrecht, NL');
    expect(screen.getByTestId(`field-${t.weight}`)).toHaveTextContent('1.5 kg');
    expect(screen.getByTestId(`field-${t.servicePoint}`)).toHaveTextContent('Kiosk Centrum');
    expect(screen.getByTestId(`field-${t.lastScan}`)).toHaveTextContent('Utrecht hub');
    expect(screen.getByTestId(`field-${t.shippingCost}`)).toHaveTextContent('4 credits');
    expect(screen.getByTestId('badges')).toHaveTextContent(en.weldstash.shipping.statuses.in_transit);
  });

  it('leaves empty fields blank and titles by order number without a tracking number', () => {
    setParcel({
      trackingNumber: null,
      trackingUrl: null,
      weight: null,
      shippingCost: null,
      servicePoint: null,
      recipientAddress: { line1: 'Postbus 1', city: 'Utrecht' },
      lastScanDate: 'not a date',
      lastScanLocation: null,
      isReturn: true,
    });
    render(<ParcelPanel {...props} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('SO-1001');
    expect(screen.getByTestId(`field-${t.weight}`)).toBeEmptyDOMElement();
    expect(screen.getByTestId(`field-${t.shippingCost}`)).toBeEmptyDOMElement();
    expect(screen.getByTestId(`field-${t.address}`)).toHaveTextContent('Postbus 1, Utrecht');
    expect(screen.getByTestId(`field-${t.lastScan}`)).toBeEmptyDOMElement();
    expect(screen.getByTestId('badges')).toHaveTextContent(en.weldstash.shipping.shipments.returnBadge);
    expect(within(screen.getByTestId('extras')).getByText('—')).toBeInTheDocument();
  });

  it('titles with the generic title when the parcel has neither tracking nor order number', () => {
    setParcel({ trackingNumber: null, orderNumber: null, carrierName: null });
    render(<ParcelPanel {...props} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t.title);
    expect(screen.getByTestId('subtitle')).toBeEmptyDOMElement();
  });

  describe('tracking link', () => {
    it('links the tracking number to the carrier', () => {
      setParcel();
      render(<ParcelPanel {...props} />);
      expect(screen.getByRole('link', { name: '3SABCD123' })).toHaveAttribute('href', 'https://track.example.com/3SABCD123');
    });

    it('shows plain text when the carrier gave no URL', () => {
      setParcel({ trackingUrl: null });
      render(<ParcelPanel {...props} />);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByText('3SABCD123', { selector: 'span.font-mono' })).toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('offers no buttons without permission', () => {
      setParcel();
      render(<ParcelPanel {...props} />);
      expect(screen.queryByRole('button', { name: t.refresh })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t.returnLabel })).not.toBeInTheDocument();
    });

    it('refreshes tracking and reports the result', async () => {
      env.allowed = new Set(['weldstash:parcels:update']);
      setParcel();
      const user = userEvent.setup();
      render(<ParcelPanel {...props} />);
      expect(screen.queryByRole('button', { name: t.returnLabel })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: t.refresh }));
      expect(env.refresh.mutate).toHaveBeenCalledWith('parcel_1', expect.any(Object));
      const options = env.refresh.mutate.mock.calls[0]![1] as MutationOptions;
      options.onSuccess?.();
      expect(toast.success).toHaveBeenCalledWith(t.refreshed);
      options.onError?.(new Error('carrier down'));
      expect(toast.error).toHaveBeenCalledWith('carrier down');
      options.onError?.(new Error(''));
      expect(toast.error).toHaveBeenLastCalledWith(t.refreshFailed);
    });

    it('disables refresh while it runs', () => {
      env.allowed = new Set(['weldstash:parcels:update']);
      env.refresh.isPending = true;
      setParcel();
      render(<ParcelPanel {...props} />);
      expect(screen.getByRole('button', { name: new RegExp(t.refresh) })).toBeDisabled();
    });

    it('creates a return label', async () => {
      env.allowed = new Set(['weldstash:parcels:create']);
      setParcel();
      const user = userEvent.setup();
      render(<ParcelPanel {...props} />);
      expect(screen.queryByRole('button', { name: t.refresh })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: t.returnLabel }));
      expect(env.createReturn.mutate).toHaveBeenCalledWith({ id: 'parcel_1' }, expect.any(Object));
      const options = env.createReturn.mutate.mock.calls[0]![1] as MutationOptions;
      options.onSuccess?.();
      expect(toast.success).toHaveBeenCalledWith(t.returnCreated);
      expect(options.onError?.(new Error('x'))).toBeUndefined();
    });

    it('shows the error notice and disables the button while the return label is made', () => {
      env.allowed = new Set(['weldstash:parcels:create']);
      env.createReturn = { mutate: vi.fn(), isPending: true, isError: true, error: new Error('nope') };
      setParcel();
      render(<ParcelPanel {...props} />);
      expect(screen.getByRole('button', { name: new RegExp(t.returnLabel) })).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(t.returnFailed);
    });

    it.each([
      ['a return parcel', { isReturn: true }],
      ['a cancelled parcel', { status: 'cancelled' as const }],
      ['a draft parcel', { status: 'draft' as const }],
      ['a parcel still being labelled', { status: 'labelling' as const }],
    ])('does not offer a return label for %s', (_name, over) => {
      env.allowed = new Set(['weldstash:parcels:create']);
      setParcel(over);
      render(<ParcelPanel {...props} />);
      expect(screen.queryByRole('button', { name: t.returnLabel })).not.toBeInTheDocument();
    });
  });

  describe('files', () => {
    it('offers the label, named after the tracking number', () => {
      setParcel();
      render(<ParcelPanel {...props} />);
      expect(screen.getByTestId('files-label-parcel_1')).toHaveTextContent('label-3SABCD123');
      expect(screen.queryByTestId('files-customs-parcel_1')).not.toBeInTheDocument();
    });

    it('offers the customs document when there is one, and names files after the id without tracking', () => {
      setParcel({ customsFormUrl: 'https://files.example.com/c.pdf', trackingNumber: null });
      render(<ParcelPanel {...props} />);
      expect(screen.getByTestId('files-customs-parcel_1')).toHaveTextContent('customs-parcel_1');
    });
  });

  describe('return parcels', () => {
    it('lists them with their status and label', () => {
      setParcel({
        returnParcels: [
          parcel({ id: 'ret_1', trackingNumber: '3SRET1', status: 'label_created', isReturn: true }),
          parcel({ id: 'ret_2', trackingNumber: null, trackingUrl: null, status: 'delivered', isReturn: true }),
        ] as Parcel[],
      });
      render(<ParcelPanel {...props} />);
      expect(screen.getByRole('heading', { name: t.returns })).toBeInTheDocument();
      expect(screen.getByTestId('files-label-ret_1')).toHaveTextContent('return-3SRET1');
      expect(screen.getByTestId('files-label-ret_2')).toHaveTextContent('return-ret_2');
      expect(screen.getByText(en.weldstash.shipping.statuses.delivered)).toBeInTheDocument();
    });

    it('omits the section without return parcels', () => {
      setParcel();
      render(<ParcelPanel {...props} />);
      expect(screen.queryByRole('heading', { name: t.returns })).not.toBeInTheDocument();
    });
  });

  describe('timeline', () => {
    it('says so when the carrier reported nothing, also when the history is null', () => {
      setParcel({ statusHistory: null });
      render(<ParcelPanel {...props} />);
      expect(screen.getByText(t.timelineEmpty)).toBeInTheDocument();
    });

    it('lists events newest first with the events without a time last', () => {
      const events: ParcelStatusEvent[] = [
        { at: '2026-11-02T09:00:00Z', code: 'A', description: 'Picked up', location: 'Amsterdam' },
        { at: null, code: 'Z', description: null, location: null },
        { at: '2026-11-03T09:00:00Z', code: 'B', description: 'At sorting centre', location: null },
        { at: null, code: null, description: null, location: null },
      ];
      setParcel({ statusHistory: events });
      render(<ParcelPanel {...props} />);
      const items = within(screen.getByRole('list')).getAllByRole('listitem');
      expect(items.map((item) => item.querySelector('p.font-medium')?.textContent)).toEqual(['At sorting centre', 'Picked up', 'Z', '—']);
      expect(items[1]).toHaveTextContent('Amsterdam');
    });
  });
});
