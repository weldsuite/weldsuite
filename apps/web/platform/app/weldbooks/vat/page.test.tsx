import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingVatReturns: () => ({ data: { data: returns.data }, isLoading: false }),
  useCalculateVatReturn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: 'ent_1' }) }));
const jurisdiction = vi.hoisted(() => ({ icp: false }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ features: { vatReturn: true, icp: jurisdiction.icp }, isResolved: true, isError: false }),
}));
vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return { ...actual, isFeatureAvailable: (feature: string) => feature === 'vat-digipoort' || actual.isFeatureAvailable(feature as never) };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
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
    jurisdiction.icp = false;
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

  it('shows a zero or payable total in a neutral colour and only a refund in green', () => {
    returns.data = [
      { id: 'vr_1', periodType: 'quarterly', periodStart: '2026-01-01', periodEnd: '2026-03-31', periodLabel: 'Q1 2026', status: 'calculated', rubrieken: { r5a: 30, r5b: 30, r5g: 0 } },
      { id: 'vr_2', periodType: 'quarterly', periodStart: '2026-04-01', periodEnd: '2026-06-30', periodLabel: 'Q2 2026', status: 'calculated', rubrieken: { r5a: 150, r5b: 30, r5g: 120 } },
      { id: 'vr_3', periodType: 'quarterly', periodStart: '2026-07-01', periodEnd: '2026-09-30', periodLabel: 'Q3 2026', status: 'calculated', rubrieken: { r5a: 10, r5b: 60, r5g: -50 } },
    ] as typeof returns.data;
    renderWithProviders(<VatReturnsPage />);
    const zero = screen.getByText('Q1 2026').closest('div.group') as HTMLElement;
    const payable = screen.getByText('Q2 2026').closest('div.group') as HTMLElement;
    const refund = screen.getByText('Q3 2026').closest('div.group') as HTMLElement;
    expect(within(zero).getByText('€0.00')).not.toHaveClass('text-red-600');
    expect(within(payable).getByText('€120.00')).not.toHaveClass('text-red-600');
    expect(within(payable).getByText('€120.00')).not.toHaveClass('text-green-600');
    expect(within(refund).getByText('€-50.00')).toHaveClass('text-green-600');
  });

  it('fills in the last finished quarter and flags dates that are not a whole quarter', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 3), toFake: ['Date'] });
    try {
      const user = userEvent.setup();
      renderWithProviders(<VatReturnsPage />);
      await user.click(screen.getByRole('button', { name: 'Calculate new return' }));

      expect(screen.getByLabelText('Period start')).toHaveValue('2026-07-01');
      expect(screen.getByLabelText('Period end')).toHaveValue('2026-09-30');
      expect(screen.getByLabelText('Period Label (optional)')).toHaveValue('Q3 2026');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await user.clear(screen.getByLabelText('Period end'));
      await user.type(screen.getByLabelText('Period end'), '2026-10-31');
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

describe('VatReturnsPage › ICP declarations', () => {
  const declarations = [
    { id: 'icp_1', periodType: 'quarterly', periodStart: '2026-01-01', periodEnd: '2026-03-31', periodLabel: 'Q1 2026', status: 'calculated', totalAmount: '1200.00' },
    { id: 'icp_2', periodType: 'quarterly', periodStart: '2026-04-01', periodEnd: '2026-06-30', periodLabel: 'Q2 2026', status: 'submitted', totalAmount: '800.00', filingReference: 'dp-2' },
  ];

  function row(label: string) {
    return screen.getByText(label).closest('div.group') as HTMLElement;
  }

  beforeEach(() => {
    returns.data = [];
    jurisdiction.icp = true;
    for (const fn of [...Object.values(api), ...Object.values(toast)]) fn.mockReset();
    api.get.mockImplementation(async (path: string) => (path === '/icp-declarations' ? { data: declarations } : { data: {} }));
  });

  it('files a calculated declaration through Digipoort and says it was sent', async () => {
    api.post.mockResolvedValue({ data: { status: 'submitted' } });
    const user = userEvent.setup();
    renderWithProviders(<VatReturnsPage />);
    await screen.findByText('Q1 2026');
    expect(within(row('Q2 2026')).queryByRole('button', { name: 'File' })).not.toBeInTheDocument();

    await user.click(within(row('Q1 2026')).getByRole('button', { name: 'File' }));
    expect(api.post).toHaveBeenCalledWith('/icp-declarations/icp_1/file');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ICP declaration sent through Digipoort. Check the status later.'));
  });

  it('shows the reason when filing is refused', async () => {
    api.post.mockRejectedValue(new Error('Digipoort refused the message (510)'));
    const user = userEvent.setup();
    renderWithProviders(<VatReturnsPage />);
    await screen.findByText('Q1 2026');
    await user.click(within(row('Q1 2026')).getByRole('button', { name: 'File' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Digipoort refused the message (510)'));
  });

  it('checks the status of a submitted declaration', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/icp-declarations') return { data: declarations };
      if (path === '/icp-declarations/icp_2/filing-status') {
        return { data: { success: true, status: 'accepted', statusDescription: 'Aanlevering verwerkt' } };
      }
      return { data: {} };
    });
    const user = userEvent.setup();
    renderWithProviders(<VatReturnsPage />);
    await screen.findByText('Q2 2026');
    await user.click(within(row('Q2 2026')).getByRole('button', { name: 'Check status' }));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('ICP declaration status: Accepted', { description: 'Aanlevering verwerkt' }),
    );
  });

  it('says when the status check failed', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/icp-declarations') return { data: declarations };
      return { data: { success: false, error: 'Digipoort is unreachable' } };
    });
    const user = userEvent.setup();
    renderWithProviders(<VatReturnsPage />);
    await screen.findByText('Q2 2026');
    await user.click(within(row('Q2 2026')).getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Digipoort is unreachable'));
  });
});
