import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  bills: [] as unknown[],
  navigate: vi.fn(),
  panel: { open: vi.fn(), sync: vi.fn() },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => env.navigate }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.panel.open }),
  useObjectPanelUrlSync: env.panel.sync,
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingBills: () => ({ data: { data: env.bills }, isLoading: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => value ?? '-',
  }),
}));

import BillsPage from './page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

function bill(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bil_1',
    billNumber: 'BILL-1',
    contactName: 'Dell',
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount: null,
    total: '1082.50',
    currency: 'USD',
    status: 'approved',
    ...overrides,
  };
}

describe('BillsPage', () => {
  beforeEach(() => {
    env.bills = [bill()];
    env.navigate.mockReset();
    env.panel.open.mockReset();
    env.panel.sync.mockReset();
  });

  it('keeps the panel in step with the ?stack= param of the bills list', () => {
    renderWithProviders(<BillsPage />);
    expect(env.panel.sync).toHaveBeenCalledWith('/weldbooks/bills');
  });

  it('opens a bill in the bill record panel', async () => {
    renderWithProviders(<BillsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'BILL-1' }));
    expect(env.panel.open).toHaveBeenCalledWith({ type: 'bill', id: 'bil_1' });
    expect(env.navigate).not.toHaveBeenCalled();
  });
});
