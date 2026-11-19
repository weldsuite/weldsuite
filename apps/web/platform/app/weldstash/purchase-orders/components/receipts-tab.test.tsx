import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PurchaseOrderLine, PurchaseOrderReceipt } from '@weldsuite/app-api-client/schemas/purchase-orders';

const env = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  usePurchaseOrderReceipts: () => env.query,
}));

import { ReceiptsTab } from './receipts-tab';

const lines = [{ id: 'poi_1', name: 'Widget' }] as PurchaseOrderLine[];

function receipt(overrides: Partial<PurchaseOrderReceipt> = {}): PurchaseOrderReceipt {
  return {
    id: 'rcp_1',
    purchaseOrderId: 'po_1',
    idempotencyKey: 'key',
    lines: [{ itemId: 'poi_1', quantity: 4, rejected: 0, locationId: null, lotNumber: null, expiryDate: null, adjustmentIds: [] }],
    receivedAt: '2026-11-10T10:00:00Z',
    receivedBy: 'user_1',
    receivedByName: 'Sam Smith',
    notes: null,
    createdAt: '2026-11-10T10:00:00Z',
    ...overrides,
  };
}

function result(partial: Record<string, unknown>) {
  env.query = { data: [], isLoading: false, isError: false, refetch: env.refetch, ...partial };
}

beforeEach(() => {
  env.refetch.mockReset();
  result({});
});

describe('ReceiptsTab', () => {
  it('shows only a spinner while the receipts load', () => {
    result({ data: undefined, isLoading: true });
    render(<ReceiptsTab orderId="po_1" lines={lines} />);
    expect(screen.queryByText('Nothing received yet')).not.toBeInTheDocument();
  });

  it('shows the error and retries on request', async () => {
    result({ data: undefined, isError: true, error: new Error('Boom') });
    const user = userEvent.setup();
    render(<ReceiptsTab orderId="po_1" lines={lines} />);
    expect(screen.getByText('Boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button'));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('falls back to a generic error message', () => {
    result({ data: undefined, isError: true, error: null });
    render(<ReceiptsTab orderId="po_1" lines={lines} />);
    expect(screen.getByText('Could not load the receipts.')).toBeInTheDocument();
  });

  it('explains an order with no receipts', () => {
    render(<ReceiptsTab orderId="po_1" lines={lines} />);
    expect(screen.getByText('Nothing received yet')).toBeInTheDocument();
  });

  it('treats missing data as no receipts', () => {
    result({ data: undefined });
    render(<ReceiptsTab orderId="po_1" lines={lines} />);
    expect(screen.getByText('Nothing received yet')).toBeInTheDocument();
  });

  it('lists a receipt with who received it, the line name and its notes', () => {
    result({ data: [receipt({ notes: 'Pallet damaged' })] });
    render(<ReceiptsTab orderId="po_1" lines={lines} />);
    expect(screen.getByText('Received by Sam Smith')).toBeInTheDocument();
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText('4 received')).toBeInTheDocument();
    expect(screen.getByText('Pallet damaged')).toBeInTheDocument();
  });

  it('shows rejected, lot and expiry, and the line id when the line is unknown', () => {
    result({
      data: [
        receipt({
          receivedByName: null,
          lines: [{ itemId: 'gone_1', quantity: 2, rejected: 1, locationId: null, lotNumber: 'L-7', expiryDate: '2027-01-31', adjustmentIds: [] }],
        }),
      ],
    });
    render(<ReceiptsTab orderId="po_1" lines={lines} />);
    expect(screen.getByText('gone_1')).toBeInTheDocument();
    const detail = screen.getByText(/2 received/);
    expect(detail).toHaveTextContent('1 rejected');
    expect(detail).toHaveTextContent('lot L-7');
    expect(detail).toHaveTextContent('expires');
    expect(screen.queryByText(/Received by/)).not.toBeInTheDocument();
  });
});
