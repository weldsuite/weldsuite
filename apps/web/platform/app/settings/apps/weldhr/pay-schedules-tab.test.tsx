import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const m = vi.hoisted(() => ({
  employers: { data: undefined as unknown, isLoading: false, error: null as unknown },
  schedules: { data: undefined as unknown, error: null as unknown },
  remove: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: m.toastError, success: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children }: { to: string; search?: Record<string, string>; children: React.ReactNode }) => (
    <a href={`${to}?tab=${search?.tab ?? ''}`}>{children}</a>
  ),
}));
vi.mock('@weldsuite/i18n/client', async () => {
  const { createTranslator } = await import('@weldsuite/i18n');
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  const t = createTranslator(locale as unknown as Record<string, unknown>);
  return { useTranslations: () => t };
});
vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useHrPayrollEmployers: () => m.employers,
  useHrPayrollSchedules: () => m.schedules,
  useDeleteHrPaySchedule: () => ({ mutateAsync: m.remove, isPending: false }),
}));
vi.mock('@/app/weldhr/payroll/components/schedule-dialog', () => ({
  ScheduleDialog: ({ schedule, employers, onClose }: { schedule?: { name: string }; employers: unknown[]; onClose: () => void }) => (
    <div role="dialog">
      <p>{schedule ? `edit ${schedule.name}` : 'new schedule'}</p>
      <p>{`${employers.length} employers`}</p>
      <button onClick={onClose}>close dialog</button>
    </div>
  ),
}));

import { PaySchedulesTab } from './pay-schedules-tab';

const ts = en.weldhr.payroll.settings;

const employer = { id: 'emp_1', name: 'Acme BV' };
const monthly = {
  id: 'ps_1',
  name: 'Monthly salaries',
  employerId: 'emp_1',
  frequency: 'monthly',
  isActive: true,
  employeeCount: 12,
  payDateRule: { kind: 'day_of_month', day: 25 },
  nextPeriod: { start: '2026-12-01', end: '2026-12-31', payDate: '2026-12-25' },
};
const weekly = {
  id: 'ps_2',
  name: 'Weekly crew',
  employerId: 'emp_gone',
  frequency: 'weekly',
  isActive: false,
  employeeCount: 3,
  payDateRule: { kind: 'offset_after_end', days: 5 },
  nextPeriod: null,
};
const lastDay = { ...monthly, id: 'ps_3', name: 'Last day', payDateRule: { kind: 'last_business_day' } };

describe('WeldHR pay schedules tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.employers = { data: [employer], isLoading: false, error: null };
    m.schedules = { data: [], error: null };
    m.remove.mockResolvedValue(undefined);
  });

  it('shows a loader while the employers load', () => {
    m.employers = { data: undefined, isLoading: true, error: null };
    render(<PaySchedulesTab />);
    expect(screen.queryByText(ts.employers.title)).toBeNull();
  });

  it('points to Settings → Entities for the employers', () => {
    render(<PaySchedulesTab />);
    expect(screen.getByText(ts.employers.title)).toBeTruthy();
    expect(screen.getByText(ts.employers.movedNotice)).toBeTruthy();
    expect(screen.getByRole('link', { name: ts.employers.manage }).getAttribute('href')).toBe('/settings/entities?tab=employers');
  });

  it('asks for an employer first and hides the add button when there is none', () => {
    m.employers = { data: [], isLoading: false, error: null };
    render(<PaySchedulesTab />);
    expect(screen.getByText(ts.schedules.needEmployer)).toBeTruthy();
    expect(screen.queryByRole('button', { name: ts.schedules.add })).toBeNull();
  });

  it('shows the empty state when the employer has no schedules', () => {
    render(<PaySchedulesTab />);
    expect(screen.getByText(ts.schedules.empty)).toBeTruthy();
  });

  it('shows load errors for the employers and the schedules', () => {
    m.employers = { data: [employer], isLoading: false, error: new Error('employers down') };
    m.schedules = { data: [], error: new Error('schedules down') };
    render(<PaySchedulesTab />);
    expect(screen.getByText('employers down')).toBeTruthy();
    expect(screen.getByText('schedules down')).toBeTruthy();
  });

  it('lists schedules with employer, pay rule, headcount and next period', () => {
    m.schedules = { data: [monthly, weekly, lastDay], error: null };
    render(<PaySchedulesTab />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);

    const first = within(rows[0]!);
    expect(first.getByText('Monthly salaries')).toBeTruthy();
    expect(first.getByText(/Acme BV · paid on day 25 · /)).toBeTruthy();
    expect(first.getByText(/Next period: .*pay date/)).toBeTruthy();

    const second = within(rows[1]!);
    expect(second.getByText(ts.employers.inactive)).toBeTruthy();
    expect(second.getByText(/— · paid 5 days after the period · /)).toBeTruthy();
    expect(second.getByText(ts.schedules.noNextPeriod)).toBeTruthy();

    expect(within(rows[2]!).getByText(/paid on the last business day/)).toBeTruthy();
  });

  it('opens the dialog to add a schedule and closes it again', async () => {
    render(<PaySchedulesTab />);
    await userEvent.click(screen.getByRole('button', { name: ts.schedules.add }));
    expect(screen.getByText('new schedule')).toBeTruthy();
    expect(screen.getByText('1 employers')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'close dialog' }));
    expect(screen.queryByText('new schedule')).toBeNull();
  });

  it('opens the dialog to edit a schedule', async () => {
    m.schedules = { data: [monthly], error: null };
    render(<PaySchedulesTab />);
    await userEvent.click(screen.getByRole('button', { name: en.weldhr.common.edit }));
    expect(screen.getByText('edit Monthly salaries')).toBeTruthy();
  });

  it('deletes a schedule after confirming', async () => {
    m.schedules = { data: [monthly], error: null };
    render(<PaySchedulesTab />);
    await userEvent.click(screen.getByRole('button', { name: en.weldhr.common.delete }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ts.schedules.deleteDescription.replace('{name}', 'Monthly salaries'))).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldhr.common.delete }));
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith('ps_1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the confirm dialog and toasts when deleting fails', async () => {
    m.remove.mockRejectedValue(new Error('has pay runs'));
    m.schedules = { data: [monthly], error: null };
    render(<PaySchedulesTab />);
    await userEvent.click(screen.getByRole('button', { name: en.weldhr.common.delete }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldhr.common.delete }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('has pay runs'));
  });

  it('closes the confirm dialog on cancel without deleting', async () => {
    m.schedules = { data: [monthly], error: null };
    render(<PaySchedulesTab />);
    await userEvent.click(screen.getByRole('button', { name: en.weldhr.common.delete }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldhr.common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(m.remove).not.toHaveBeenCalled();
  });
});
