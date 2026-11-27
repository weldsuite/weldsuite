import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

const env = vi.hoisted(() => ({ pending: new Map<string, { batchId: string; executionDate: string }>() }));

vi.mock('@/hooks/queries/use-weldbooks-receipts-queries', () => ({ usePendingBillMap: () => env.pending }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => ({ formatDate: (value: string) => `on ${value}` }) }));

import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import { PaymentPendingChip } from './payment-pending-chip';

beforeEach(() => {
  env.pending = new Map([['bill_1', { batchId: 'batch_1', executionDate: '2026-12-01' }]]);
});

describe('PaymentPendingChip', () => {
  it('marks a bill that is in an exported file, with the date in its tooltip', () => {
    renderWithProviders(<PaymentPendingChip billId="bill_1" status="approved" />);

    const chip = screen.getByTestId('payment-pending-chip');
    expect(chip).toHaveTextContent('Payment pending');
    expect(chip).toHaveAttribute('title', 'In the SEPA file for on 2026-12-01. The bill is paid when its bank line arrives.');
  });

  it('shows nothing for a bill that is not pending', () => {
    renderWithProviders(<PaymentPendingChip billId="bill_2" status="approved" />);
    expect(screen.queryByTestId('payment-pending-chip')).not.toBeInTheDocument();
  });

  it('shows nothing once the bill is paid or void, whatever the batch says', () => {
    const { unmount } = renderWithProviders(<PaymentPendingChip billId="bill_1" status="paid" />);
    expect(screen.queryByTestId('payment-pending-chip')).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<PaymentPendingChip billId="bill_1" status="void" />);
    expect(screen.queryByTestId('payment-pending-chip')).not.toBeInTheDocument();
  });

  it('shows nothing where the edition has no SEPA files (an empty set)', () => {
    env.pending = new Map();
    renderWithProviders(<PaymentPendingChip billId="bill_1" status="approved" />);
    expect(screen.queryByTestId('payment-pending-chip')).not.toBeInTheDocument();
  });
});
