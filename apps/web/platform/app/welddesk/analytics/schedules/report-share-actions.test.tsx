/**
 * Export CSV and Schedule on a report header: the overview exports the
 * selected range, a saved report exports itself, a failure toasts, and
 * scheduling needs settings:create.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

interface MutateOptions {
  onError?: () => void;
}

const state = vi.hoisted(() => ({
  overview: { mutate: (() => undefined) as (range: string, options: MutateOptions) => void, isPending: false },
  report: { mutate: (() => undefined) as (id: string, options: MutateOptions) => void, isPending: false },
  canCreate: true,
  toastError: (() => undefined) as (message: string) => void,
}));

vi.mock('@/hooks/queries/use-desk-reports-queries', () => ({
  useExportDeskOverviewCsv: () => state.overview,
  useExportDeskReportCsv: () => state.report,
}));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));
vi.mock('sonner', () => ({ toast: { error: (message: string) => state.toastError(message) } }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('./schedule-dialog', () => ({
  ScheduleDialog: ({ open, defaults }: { open: boolean; defaults?: { reportId?: string | null; range?: string } }) =>
    open ? <div data-testid="dialog">{JSON.stringify(defaults)}</div> : null,
}));

import { ReportShareActions } from './report-share-actions';

beforeEach(() => {
  state.overview = { mutate: vi.fn(), isPending: false };
  state.report = { mutate: vi.fn(), isPending: false };
  state.canCreate = true;
  state.toastError = vi.fn();
});

afterEach(cleanup);

describe('ReportShareActions', () => {
  it('exports the overview of the selected range', () => {
    render(<ReportShareActions range="last_90_days" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(state.overview.mutate).toHaveBeenCalledWith('last_90_days', expect.anything());
    expect(state.report.mutate).not.toHaveBeenCalled();
  });

  it('exports a saved report by its id', () => {
    render(<ReportShareActions reportId="rpt_1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(state.report.mutate).toHaveBeenCalledWith('rpt_1', expect.anything());
    expect(state.overview.mutate).not.toHaveBeenCalled();
  });

  it('shows a pending state while the file downloads', () => {
    state.overview.isPending = true;
    render(<ReportShareActions range="last_7_days" />);
    const button = screen.getByRole('button', { name: 'Exporting...' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('toasts when the export fails', () => {
    state.overview.mutate = vi.fn((_range, options) => options.onError?.());
    render(<ReportShareActions range="last_7_days" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(state.toastError).toHaveBeenCalledWith('The export failed');
  });

  it('opens the schedule dialog on this report and range', () => {
    render(<ReportShareActions range="last_30_days" />);
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(JSON.parse(screen.getByTestId('dialog').textContent ?? '')).toEqual({ reportId: null, range: 'last_30_days' });
  });

  it('opens the schedule dialog on a saved report', () => {
    render(<ReportShareActions reportId="rpt_1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(JSON.parse(screen.getByTestId('dialog').textContent ?? '')).toEqual({ reportId: 'rpt_1' });
  });

  it('leaves the schedule button out without settings:create', () => {
    state.canCreate = false;
    render(<ReportShareActions range="last_30_days" />);
    expect(screen.queryByRole('button', { name: 'Schedule' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
  });
});
