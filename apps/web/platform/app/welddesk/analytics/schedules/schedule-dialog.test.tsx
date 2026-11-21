/**
 * The schedule form: a weekly schedule needs a day, a monthly one a day of the
 * month, recipients are validated, deduplicated and capped, and the body that
 * is sent differs for the overview and for a saved report.
 */

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HelpdeskReportScheduleDto } from '@weldsuite/core-api-client/schemas/helpdesk-analytics';

const state = vi.hoisted(() => ({
  language: 'en' as 'en' | 'nl',
  create: { mutateAsync: (() => Promise.resolve({})) as (input: unknown) => Promise<unknown>, isPending: false },
  update: { mutateAsync: (() => Promise.resolve({})) as (input: unknown) => Promise<unknown>, isPending: false },
  toastSuccess: (() => undefined) as (message: string) => void,
  toastError: (() => undefined) as (message: string) => void,
}));

vi.mock('@/hooks/queries/use-desk-reports-queries', () => ({
  useCreateDeskReportSchedule: () => state.create,
  useUpdateDeskReportSchedule: () => state.update,
}));
vi.mock('@/hooks/queries/use-helpdesk-queries', () => ({
  useAnalyticsReports: () => ({ data: { data: [{ id: 'rpt_1', title: 'Escalations' }] } }),
}));
vi.mock('@/lib/timezones', () => ({ getBrowserTimezone: () => 'Europe/Amsterdam' }));
vi.mock('sonner', () => ({
  toast: {
    success: (message: string) => state.toastSuccess(message),
    error: (message: string) => state.toastError(message),
  },
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: state.language === 'nl' ? dutch : english, language: state.language }) };
});

// Native selects stand in for the Radix ones, which need a real layout. The
// trigger's aria-label names the select.
vi.mock('@weldsuite/ui/components/select', () => {
  const SelectTrigger = (_props: { id?: string; 'aria-label'?: string; children?: ReactNode }) => null;
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => {
      const trigger = Children.toArray(children).find(
        (child): child is ReactElement<{ 'aria-label'?: string }> => isValidElement(child) && child.type === SelectTrigger,
      );
      return (
        <select aria-label={trigger?.props['aria-label']} value={value} onChange={(event) => onValueChange(event.target.value)}>
          <option value="">-</option>
          {children}
        </select>
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  };
});

import { ScheduleDialog, buildScheduleBody, defaultScheduleValues } from './schedule-dialog';

const created = vi.fn<(input: unknown) => Promise<unknown>>(() => Promise.resolve({}));
const updated = vi.fn<(input: unknown) => Promise<unknown>>(() => Promise.resolve({}));

function renderDialog(props: { schedule?: HelpdeskReportScheduleDto; defaults?: { reportId?: string | null; range?: string } } = {}) {
  const onOpenChange = vi.fn();
  render(<ScheduleDialog open onOpenChange={onOpenChange} {...props} />);
  return onOpenChange;
}

function addRecipient(address: string) {
  const input = screen.getByPlaceholderText('name@company.com');
  fireEvent.change(input, { target: { value: address } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

function choose(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

beforeEach(() => {
  state.language = 'en';
  created.mockClear();
  updated.mockClear();
  state.create = { mutateAsync: created, isPending: false };
  state.update = { mutateAsync: updated, isPending: false };
  state.toastSuccess = vi.fn();
  state.toastError = vi.fn();
});

afterEach(cleanup);

describe('ScheduleDialog form', () => {
  it('says plainly that reports count whole UTC days', () => {
    renderDialog();
    expect(screen.getByText(/whole UTC days/)).toBeTruthy();
  });

  it('needs a day of the week for a weekly schedule', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekly' } });
    addRecipient('lead@example.com');
    save();
    expect(await screen.findByText('Choose a day of the week')).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
  });

  it('needs a day of the month for a monthly schedule', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Monthly' } });
    addRecipient('lead@example.com');
    choose('Frequency', 'monthly');
    expect(screen.queryByLabelText('Day of the week')).toBeNull();
    save();
    expect(await screen.findByText('Choose a day of the month')).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
  });

  it('needs a name and at least one recipient', async () => {
    renderDialog();
    save();
    expect(await screen.findByText('Give the schedule a name')).toBeTruthy();
    expect(screen.getByText('Add at least one recipient')).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
  });

  it('sends the overview with its period and no saved report', async () => {
    const onOpenChange = renderDialog({ defaults: { range: 'last_30_days' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Monday overview' } });
    addRecipient('Lead@Example.com');
    choose('Day of the week', '1');
    save();

    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0]![0]).toEqual({
      name: 'Monday overview',
      range: 'last_30_days',
      frequency: 'weekly',
      dayOfWeek: 1,
      dayOfMonth: null,
      hour: 8,
      timezone: 'Europe/Amsterdam',
      recipients: ['lead@example.com'],
      attachCsv: true,
      locale: 'en',
      enabled: true,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(state.toastSuccess).toHaveBeenCalledWith('Schedule created');
  });

  it('sends a saved report without a period, with the day its frequency needs', async () => {
    renderDialog({ defaults: { reportId: 'rpt_1', range: 'last_30_days' } });
    // A saved report's charts carry their own periods.
    expect(screen.queryByLabelText('Period')).toBeNull();
    expect(screen.getByText('The charts of a saved report have their own periods.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Escalations monthly' } });
    addRecipient('lead@example.com');
    choose('Frequency', 'monthly');
    choose('Day of the month', '15');
    choose('Time', '9');
    save();

    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0]![0]).toEqual({
      name: 'Escalations monthly',
      reportId: 'rpt_1',
      frequency: 'monthly',
      dayOfWeek: null,
      dayOfMonth: 15,
      hour: 9,
      timezone: 'Europe/Amsterdam',
      recipients: ['lead@example.com'],
      attachCsv: true,
      locale: 'en',
      enabled: true,
    });
  });

  it('defaults the email language to the interface language when it is nl', () => {
    state.language = 'nl';
    expect(defaultScheduleValues('nl').locale).toBe('nl');
    expect(defaultScheduleValues('en').locale).toBe('en');
    expect(defaultScheduleValues('fr').locale).toBe('en');
  });

  it('updates an existing schedule, clearing the saved report when it is the overview', async () => {
    renderDialog({
      schedule: {
        id: 'sched_1',
        createdAt: '',
        updatedAt: '',
        name: 'Daily',
        reportId: null,
        reportTitle: null,
        range: 'yesterday',
        frequency: 'daily',
        dayOfWeek: null,
        dayOfMonth: null,
        hour: 7,
        timezone: 'UTC',
        recipients: ['a@example.com'],
        attachCsv: false,
        locale: 'nl',
        enabled: true,
        createdById: null,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
      },
    });
    expect(screen.getByText('Edit schedule')).toBeTruthy();
    save();
    await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    const call = updated.mock.calls[0]![0] as { id: string; input: Record<string, unknown> };
    expect(call.id).toBe('sched_1');
    expect(call.input).toMatchObject({ reportId: null, range: 'yesterday', frequency: 'daily', hour: 7, locale: 'nl', attachCsv: false });
    expect(state.toastSuccess).toHaveBeenCalledWith('Schedule saved');
  });

  it('toasts when the save fails and keeps the dialog open', async () => {
    created.mockRejectedValueOnce(new Error('400'));
    const onOpenChange = renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    addRecipient('lead@example.com');
    choose('Frequency', 'daily');
    save();
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('The schedule could not be saved'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('ScheduleDialog recipients', () => {
  it('refuses an invalid address with a message', () => {
    renderDialog();
    addRecipient('not-an-email');
    expect(screen.getByText('"not-an-email" is not a valid email address')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('adds several addresses at once, lower-cased and without duplicates', () => {
    renderDialog();
    addRecipient('A@example.com, b@example.com; a@example.com');
    expect(screen.getAllByRole('button', { name: /^Remove/ }).map((button) => button.getAttribute('aria-label'))).toEqual([
      'Remove a@example.com',
      'Remove b@example.com',
    ]);
  });

  it('removes an address with its chip', () => {
    renderDialog();
    addRecipient('a@example.com, b@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@example.com' }));
    expect(screen.queryByRole('button', { name: 'Remove a@example.com' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove b@example.com' })).toBeTruthy();
  });

  it('stops at 20 recipients', () => {
    renderDialog();
    addRecipient(Array.from({ length: 21 }, (_, index) => `user${index}@example.com`).join(','));
    expect(screen.getAllByRole('button', { name: /^Remove/ })).toHaveLength(20);
    expect(screen.getByText('At most 20 recipients')).toBeTruthy();
  });
});

describe('buildScheduleBody', () => {
  const base = defaultScheduleValues('en');

  it('drops the day a frequency does not use', () => {
    const body = buildScheduleBody({ ...base, frequency: 'daily', dayOfWeek: 3, dayOfMonth: 9, reportId: null }, false);
    expect(body.dayOfWeek).toBeNull();
    expect(body.dayOfMonth).toBeNull();
  });

  it('leaves the period out for a saved report and the saved report out of a create for the overview', () => {
    expect('range' in buildScheduleBody({ ...base, reportId: 'rpt_1' }, false)).toBe(false);
    expect('reportId' in buildScheduleBody({ ...base, reportId: null }, false)).toBe(false);
    expect(buildScheduleBody({ ...base, reportId: null }, true).reportId).toBeNull();
  });
});
