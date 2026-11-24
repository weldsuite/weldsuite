import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { Parcel } from '@weldsuite/app-api-client/schemas/shipping';
import type { ColumnDef } from '@/components/panel-entity-list';
import { buildParcelColumns, recipientSummary } from './parcel-columns';

const t = en.weldstash.shipping;

function parcel(over: Partial<Parcel> = {}): Parcel {
  return {
    id: 'parcel_1',
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
    status: 'in_transit',
    statusHistory: null,
    trackingNumber: '3SABCD123',
    trackingUrl: 'https://track.example.com/3SABCD123',
    carrierId: null,
    carrierName: 'PostNL',
    carrierCode: 'postnl',
    serviceType: null,
    carrierReference: null,
    colloNumber: null,
    pickListId: null,
    shipmentId: null,
    orderId: null,
    orderNumber: 'SO-1001',
    referenceNumber: null,
    recipientName: 'Ann Archer',
    recipientCompany: 'Archer BV',
    recipientEmail: null,
    recipientPhone: null,
    recipientAddress: { city: 'Utrecht', country: 'NL' },
    senderName: null,
    senderCompany: null,
    senderAddress: null,
    weight: null,
    dimensions: null,
    servicePoint: null,
    shippingCost: null,
    labelUrl: null,
    labelFormat: null,
    customsFormUrl: null,
    customsInfo: null,
    isReturn: false,
    returnForParcelId: null,
    returnTrackingNumber: null,
    returnLabelUrl: null,
    shippedAt: '2026-11-02',
    estimatedDeliveryDate: null,
    actualDeliveryDate: null,
    lastScanDate: null,
    lastScanLocation: null,
    trackingNextCheckAt: null,
    ...over,
  };
}

function column(id: string): ColumnDef<Parcel> {
  const found = buildParcelColumns().find((c) => c.id === id);
  if (!found) throw new Error(`no column ${id}`);
  return found;
}

function renderCell(id: string, row: Parcel) {
  // The cell render needs none of the row actions.
  const actions = { onEdit: () => undefined, onDelete: () => undefined, onDuplicate: () => undefined, onUpdate: () => undefined };
  return render(<div data-testid="cell">{column(id).render(row, actions)}</div>);
}

describe('recipientSummary', () => {
  it('is the company, then the city and country', () => {
    expect(recipientSummary(parcel())).toBe('Archer BV · Utrecht, NL');
  });

  it('falls back to the name, and to nothing', () => {
    expect(recipientSummary(parcel({ recipientCompany: null }))).toBe('Ann Archer · Utrecht, NL');
    expect(recipientSummary(parcel({ recipientCompany: null, recipientName: null, recipientAddress: null }))).toBe('');
  });
});

describe('buildParcelColumns', () => {
  it('has the columns in order, with translated headers', () => {
    const columns = buildParcelColumns();
    expect(columns.map((c) => c.id)).toEqual(['status', 'tracking', 'carrier', 'recipient', 'order', 'created', 'shipped']);
    expect(columns.map((c) => c.header)).toEqual([
      t.shipments.colStatus,
      t.shipments.colTracking,
      t.shipments.colCarrier,
      t.shipments.colRecipient,
      t.shipments.colOrder,
      t.shipments.colCreated,
      t.shipments.colShipped,
    ]);
  });

  it('shows the status, and a badge for a return', () => {
    renderCell('status', parcel({ status: 'delivered', isReturn: true }));
    expect(screen.getByText(t.statuses.delivered)).toBeInTheDocument();
    expect(screen.getByText(t.shipments.returnBadge)).toBeInTheDocument();
  });

  it('shows no return badge for an outbound parcel', () => {
    renderCell('status', parcel());
    expect(screen.queryByText(t.shipments.returnBadge)).not.toBeInTheDocument();
  });

  it('links the tracking number to the carrier', () => {
    renderCell('tracking', parcel());
    expect(screen.getByRole('link', { name: '3SABCD123' })).toHaveAttribute('href', 'https://track.example.com/3SABCD123');
  });

  it('shows the tracking number as text without a URL, and a dash without a number', () => {
    const { unmount } = renderCell('tracking', parcel({ trackingUrl: null }));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('3SABCD123')).toBeInTheDocument();
    unmount();
    renderCell('tracking', parcel({ trackingNumber: null }));
    expect(screen.getByTestId('cell')).toHaveTextContent('—');
  });

  it('shows carrier, recipient and order, with dashes for what is missing', () => {
    const { unmount } = renderCell('carrier', parcel());
    expect(screen.getByTestId('cell')).toHaveTextContent('PostNL');
    unmount();
    const second = renderCell('recipient', parcel());
    expect(screen.getByTestId('cell')).toHaveTextContent('Archer BV · Utrecht, NL');
    second.unmount();
    const third = renderCell('order', parcel());
    expect(screen.getByTestId('cell')).toHaveTextContent('SO-1001');
    third.unmount();

    const empty = parcel({ carrierName: null, recipientCompany: null, recipientName: null, recipientAddress: null, orderNumber: null });
    for (const id of ['carrier', 'recipient', 'order']) {
      const view = renderCell(id, empty);
      expect(screen.getByTestId('cell')).toHaveTextContent('—');
      view.unmount();
    }
  });

  it('shows the created and shipped dates, or a dash', () => {
    const { unmount } = renderCell('created', parcel());
    expect(screen.getByTestId('cell')).toHaveTextContent('2026');
    unmount();
    const second = renderCell('shipped', parcel());
    expect(screen.getByTestId('cell')).toHaveTextContent('2026');
    second.unmount();
    renderCell('shipped', parcel({ shippedAt: null }));
    expect(screen.getByTestId('cell')).toHaveTextContent('—');
  });
});
