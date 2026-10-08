import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FiscalCalendar, FiscalCalendarParams, PlannedFiscalPeriod } from '@/lib/api/domains/weldbooks-assets';

const generateAsync = vi.fn();
const permissions = new Set(['reports:read', 'reports:create']);
let calendar: FiscalCalendar;
const calendarParams: FiscalCalendarParams[] = [];

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatDate: (value: string) => value, today: () => '2026-03-10' }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useFiscalCalendar: (params: FiscalCalendarParams) => {
    calendarParams.push(params);
    return { data: calendar, isLoading: false, isError: false, refetch: vi.fn() };
  },
  useGenerateFiscalPeriods: () => ({ mutateAsync: generateAsync, isPending: false }),
}));

import FiscalPeriodsPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../fixed-assets/test-utils';

const weekPeriods = (existing: number): PlannedFiscalPeriod[] => {
  // A 53-week year: three quarters of 4-4-5 weeks and a last one of 4-4-6.
  const weeks = [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 6];
  let start = new Date('2025-12-29T00:00:00Z');
  return weeks.map((count, index) => {
    const end = new Date(start.getTime() + (count * 7 - 1) * 86_400_000);
    const period: PlannedFiscalPeriod = {
      name: `FY2026 P${String(index + 1).padStart(2, '0')}`,
      type: 'period',
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      number: index + 1,
      weeks: count,
      existingId: index < existing ? `fp_${index}` : null,
    };
    start = new Date(end.getTime() + 86_400_000);
    return period;
  });
};

describe('Fiscal periods page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    generateAsync.mockReset().mockResolvedValue({ created: new Array(9).fill({}), skipped: new Array(3).fill({}) });
    calendarParams.length = 0;
    permissions.clear();
    permissions.add('reports:read');
    permissions.add('reports:create');
    calendar = {
      entityId: 'ent_1',
      fiscalYear: 2026,
      startDate: '2025-12-29',
      endDate: '2027-01-03',
      kind: 'fifty_two_fifty_three',
      weeks: 53,
      periods: weekPeriods(3),
    };
  });

  it('previews the 4-4-5 periods of a 53-week year, with the extra week in the last one', () => {
    renderWithProviders(<FiscalPeriodsPage />);

    expect(screen.getByTestId('fiscal-summary')).toHaveTextContent('52–53 week year (4-4-5)');
    expect(screen.getByTestId('fiscal-weeks')).toHaveTextContent('53-week year');
    expect(screen.getByText(/the extra week is in period 12, which has six weeks/)).toBeInTheDocument();

    const first = screen.getByTestId('fiscal-period-FY2026 P01');
    expect(within(first).getByText('4')).toBeInTheDocument();
    expect(within(first).getByText('Exists')).toBeInTheDocument();
    const third = screen.getByTestId('fiscal-period-FY2026 P03');
    expect(within(third).getByText('5')).toBeInTheDocument();
    const last = screen.getByTestId('fiscal-period-FY2026 P12');
    expect(within(last).getByText('6')).toBeInTheDocument();
    expect(within(last).getByText('To create')).toBeInTheDocument();
  });

  it('offers to create exactly the periods that do not exist yet', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FiscalPeriodsPage />);

    const button = screen.getByTestId('fiscal-generate');
    expect(button).toHaveTextContent('Create 9 missing periods');
    await user.click(button);

    await waitFor(() => expect(generateAsync).toHaveBeenCalledTimes(1));
    expect(generateAsync).toHaveBeenCalledWith({ fiscalYear: 2026, includeQuarters: false, includeYear: false });
    expect(await screen.findByTestId('fiscal-generated')).toHaveTextContent('9 periods created, 3 already existed.');
  });

  it('asks for the quarters and the whole year when ticked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FiscalPeriodsPage />);

    await user.click(screen.getByRole('checkbox', { name: 'Also create quarters' }));
    await user.click(screen.getByRole('checkbox', { name: 'Also create the whole year' }));

    expect(calendarParams.at(-1)).toEqual({ fiscalYear: 2026, includeQuarters: true, includeYear: true });
    await user.click(screen.getByTestId('fiscal-generate'));
    await waitFor(() => expect(generateAsync).toHaveBeenCalledWith({ fiscalYear: 2026, includeQuarters: true, includeYear: true }));
  });

  it('has nothing to create when every period exists', () => {
    calendar = { ...calendar, periods: weekPeriods(12) };
    renderWithProviders(<FiscalPeriodsPage />);
    expect(screen.getByTestId('fiscal-generate')).toBeDisabled();
    expect(screen.getByTestId('fiscal-generate')).toHaveTextContent('All periods exist');
  });

  it('shows calendar months without a weeks column for a month-based fiscal year', () => {
    calendar = {
      entityId: 'ent_1',
      fiscalYear: 2026,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      kind: 'month',
      weeks: null,
      periods: Array.from({ length: 12 }, (_, index) => ({
        name: `2026-${String(index + 1).padStart(2, '0')}`,
        type: 'month' as const,
        startDate: `2026-${String(index + 1).padStart(2, '0')}-01`,
        endDate: `2026-${String(index + 1).padStart(2, '0')}-28`,
        number: index + 1,
        weeks: null,
        existingId: null,
      })),
    };
    renderWithProviders(<FiscalPeriodsPage />);

    expect(screen.getByTestId('fiscal-summary')).toHaveTextContent('Calendar months');
    expect(screen.queryByTestId('fiscal-weeks')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Weeks' })).not.toBeInTheDocument();
    expect(screen.getByTestId('fiscal-generate')).toHaveTextContent('Create 12 missing periods');
  });

  it('shows the error when generating fails', async () => {
    generateAsync.mockRejectedValueOnce(new Error('Failed to generate fiscal periods'));
    const user = userEvent.setup();
    renderWithProviders(<FiscalPeriodsPage />);
    await user.click(screen.getByTestId('fiscal-generate'));
    expect(await screen.findByTestId('fiscal-error')).toHaveTextContent('Failed to generate fiscal periods');
  });

  it('does not offer to create periods without reports:create', () => {
    permissions.delete('reports:create');
    renderWithProviders(<FiscalPeriodsPage />);
    expect(screen.queryByTestId('fiscal-generate')).not.toBeInTheDocument();
    expect(screen.getByTestId('fiscal-period-FY2026 P01')).toBeInTheDocument();
  });
});
