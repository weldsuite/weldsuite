import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const panel = vi.hoisted(() => ({ open: vi.fn(), sync: vi.fn() }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: panel.open }),
  useObjectPanelUrlSync: panel.sync,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
    formatMoney: (value: number | string) => `$${value}`,
  }),
}));

import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import { ActivityLists, paymentPanelTarget } from './activity-lists';

const td = en.accounting.dashboard;

function payment(overrides: Partial<Dashboard['recentPayments'][number]>): Dashboard['recentPayments'][number] {
  return {
    id: 'pay_1',
    type: 'received',
    amount: '120.00',
    date: '2026-11-20',
    paymentMethod: 'bank_transfer',
    reference: 'INV-7',
    invoiceId: null,
    billId: null,
    contactId: 'prt_1',
    ...overrides,
  };
}

function dashboard(recentPayments: Dashboard['recentPayments'], upcomingDue: Dashboard['upcomingDue'] = []) {
  return { recentPayments, upcomingDue } as Dashboard;
}

beforeEach(() => {
  panel.open.mockReset();
});

describe('the dashboard\'s lists', () => {
  it('shows the latest payments next to the invoices due soon', () => {
    renderWithProviders(
      <ActivityLists
        dashboard={dashboard(
          [payment({ id: 'a', invoiceId: 'inv_7' })],
          [{ id: 'inv_9', invoiceNumber: 'INV-9', contactName: 'Globex', dueDate: '2026-12-01', balanceDue: '10' }],
        )}
      />,
    );

    expect(screen.getByRole('heading', { name: td.charts.dueSoon })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: td.latestPayments })).toBeInTheDocument();
    expect(screen.getByText('INV-9')).toBeInTheDocument();
    // The type is a translated name, not the raw `received`.
    expect(screen.getByText(td.paymentTypes.received)).toBeInTheDocument();
    expect(screen.queryByText('received')).not.toBeInTheDocument();
    expect(screen.getByText('$120')).toBeInTheDocument();
  });

  it('opens the invoice a payment was recorded on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityLists dashboard={dashboard([payment({ invoiceId: 'inv_7' })])} />);

    await user.click(screen.getByRole('button', { name: 'date:2026-11-20 $120' }));
    expect(panel.open).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_7' });
  });

  it('opens the bill a payment was made on', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ActivityLists dashboard={dashboard([payment({ type: 'sent', billId: 'bill_3', amount: '80.00' })])} />,
    );

    expect(screen.getByText(td.paymentTypes.sent)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'date:2026-11-20 $80' }));
    expect(panel.open).toHaveBeenCalledWith({ type: 'bill', id: 'bill_3' });
  });

  it('does not make a payment on neither an invoice nor a bill clickable', () => {
    renderWithProviders(<ActivityLists dashboard={dashboard([payment({})])} />);
    const section = screen.getByRole('heading', { name: td.latestPayments }).closest('section');
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says so when there are no payments yet', () => {
    renderWithProviders(<ActivityLists dashboard={dashboard([])} />);
    expect(screen.getByText(td.noRecentPayments)).toBeInTheDocument();
  });

  it('picks the invoice before the bill', () => {
    expect(paymentPanelTarget({ invoiceId: 'inv_1', billId: 'bill_1' })).toEqual({ type: 'invoice', id: 'inv_1' });
    expect(paymentPanelTarget({ invoiceId: null, billId: null })).toBeNull();
  });
});
