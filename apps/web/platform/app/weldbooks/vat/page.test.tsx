import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const returns = vi.hoisted(() => ({
  data: [] as {
    id: string;
    periodType: string;
    periodStart: string;
    periodEnd: string;
    periodLabel: string | null;
    status: string;
    rubrieken?: Record<string, number>;
  }[],
}));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: {}, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingVatReturns: () => ({ data: { data: returns.data }, isLoading: false }),
  useCalculateVatReturn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: 'ent_1' }) }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ features: { vatReturn: true, icp: false }, isResolved: true, isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | null | undefined) => `€${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => (value ? `date:${value}` : ''),
  }),
}));
vi.mock('./gst-return-page', () => ({ default: () => null }));
vi.mock('./br-apuracao-page', () => ({ default: () => null }));

import VatReturnsPage from './page';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '../fixed-assets/test-utils';

describe('VatReturnsPage', () => {
  beforeEach(() => {
    panelOpen.mockReset();
    returns.data = [
      { id: 'vr_1', periodType: 'quarterly', periodStart: '2026-01-01', periodEnd: '2026-03-31', periodLabel: 'Q1 2026', status: 'calculated' },
    ];
  });

  it('lists the returns with their period, type and status', () => {
    renderWithProviders(<VatReturnsPage />);
    const row = screen.getByText('Q1 2026').closest('div.group') as HTMLElement;
    expect(row).toHaveTextContent('Quarterly');
    expect(row).toHaveTextContent('Calculated');
  });

  it('shows a zero total in a neutral colour and a payable total in red', () => {
    returns.data = [
      { id: 'vr_1', periodType: 'quarterly', periodStart: '2026-01-01', periodEnd: '2026-03-31', periodLabel: 'Q1 2026', status: 'calculated', rubrieken: { r5a: 30, r5b: 30, r5g: 0 } },
      { id: 'vr_2', periodType: 'quarterly', periodStart: '2026-04-01', periodEnd: '2026-06-30', periodLabel: 'Q2 2026', status: 'calculated', rubrieken: { r5a: 150, r5b: 30, r5g: 120 } },
    ] as typeof returns.data;
    renderWithProviders(<VatReturnsPage />);
    const zero = screen.getByText('Q1 2026').closest('div.group') as HTMLElement;
    const payable = screen.getByText('Q2 2026').closest('div.group') as HTMLElement;
    expect(within(zero).getByText('€0.00')).not.toHaveClass('text-red-600');
    expect(within(payable).getByText('€120.00')).toHaveClass('text-red-600');
  });

  it('fills in the last finished quarter and flags dates that are not a whole quarter', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 3), toFake: ['Date'] });
    try {
      const user = userEvent.setup();
      renderWithProviders(<VatReturnsPage />);
      await user.click(screen.getByRole('button', { name: 'Calculate New Return' }));

      expect(screen.getByLabelText('Period Start')).toHaveValue('2026-07-01');
      expect(screen.getByLabelText('Period End')).toHaveValue('2026-09-30');
      expect(screen.getByLabelText('Period Label (optional)')).toHaveValue('Q3 2026');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await user.clear(screen.getByLabelText('Period End'));
      await user.type(screen.getByLabelText('Period End'), '2026-10-31');
      expect(screen.getByRole('alert')).toHaveTextContent('A quarterly period runs from the first to the last day of one quarter');
      expect(screen.getByRole('button', { name: 'Calculate' })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a return in its record panel by its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VatReturnsPage />);
    await user.click(screen.getByRole('button', { name: 'Q1 2026' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'vat_return', id: 'vr_1' });
  });
});
