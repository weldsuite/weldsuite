import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const returns = vi.hoisted(() => ({
  data: [] as { id: string; periodType: string; periodStart: string; periodEnd: string; periodLabel: string | null; status: string }[],
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

  it('opens a return in its record panel by its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VatReturnsPage />);
    await user.click(screen.getByRole('button', { name: 'Q1 2026' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'vat_return', id: 'vr_1' });
  });
});
