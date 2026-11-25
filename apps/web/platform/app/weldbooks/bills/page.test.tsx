import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  bills: [] as unknown[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  observers: [] as Array<(entries: Array<{ isIntersecting: boolean }>) => void>,
  navigate: vi.fn(),
  panel: { open: vi.fn(), sync: vi.fn() },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => env.navigate }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.panel.open }),
  useObjectPanelUrlSync: env.panel.sync,
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useInfiniteAccountingBills: () => ({
    data: { rows: env.bills, totalCount: env.bills.length },
    isLoading: false,
    hasNextPage: env.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: env.fetchNextPage,
  }),
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
    env.hasNextPage = false;
    env.fetchNextPage.mockReset();
    env.observers = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          env.observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    env.navigate.mockReset();
    env.panel.open.mockReset();
    env.panel.sync.mockReset();
  });

  it('keeps the panel in step with the ?stack= param of the bills list', () => {
    renderWithProviders(<BillsPage />);
    expect(env.panel.sync).toHaveBeenCalledWith('/weldbooks/bills');
  });

  it('loads the next page of bills when the end of the list scrolls into view', () => {
    env.hasNextPage = true;
    renderWithProviders(<BillsPage />);

    expect(env.fetchNextPage).not.toHaveBeenCalled();
    act(() => env.observers.forEach((notify) => notify([{ isIntersecting: true }])));
    expect(env.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('marks the status counts as partial while more bills are still to load', () => {
    env.hasNextPage = true;
    renderWithProviders(<BillsPage />);
    expect(screen.getByText('1+')).toBeInTheDocument();
  });

  it('shows the plain status count once every bill is loaded', () => {
    renderWithProviders(<BillsPage />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.queryByText('1+')).not.toBeInTheDocument();
  });

  it('opens a bill in the bill record panel', async () => {
    renderWithProviders(<BillsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'BILL-1' }));
    expect(env.panel.open).toHaveBeenCalledWith({ type: 'bill', id: 'bil_1' });
    expect(env.navigate).not.toHaveBeenCalled();
  });
});
