/**
 * Scheduled reports list: every state of a row, send now, the enabled switch,
 * and the actions the member's permissions leave out.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HelpdeskReportScheduleDto } from '@weldsuite/core-api-client/schemas/helpdesk-analytics';

interface SendCallbacks {
  onSuccess?: (result: { status: 'sent' | 'failed'; error?: string }) => void;
  onError?: () => void;
  onSettled?: () => void;
}

const state = vi.hoisted(() => ({
  query: {} as { data: unknown; isLoading: boolean; isError: boolean; refetch: () => Promise<unknown> },
  permissions: new Set<string>(),
  update: { mutate: (() => undefined) as (input: unknown, callbacks?: unknown) => void, isPending: false },
  send: { mutate: (() => undefined) as (id: string, callbacks: SendCallbacks) => void },
  remove: { mutateAsync: (() => Promise.resolve()) as (id: string) => Promise<void> },
  toastSuccess: (() => undefined) as (message: string) => void,
  toastError: (() => undefined) as (message: string) => void,
}));

vi.mock('@/hooks/queries/use-desk-reports-queries', () => ({
  useDeskReportSchedules: () => state.query,
  useUpdateDeskReportSchedule: () => state.update,
  useSendDeskReportSchedule: () => state.send,
  useDeleteDeskReportSchedule: () => state.remove,
}));

vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('sonner', () => ({
  toast: {
    success: (message: string) => state.toastSuccess(message),
    error: (message: string) => state.toastError(message),
  },
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('./schedule-dialog', () => ({
  ScheduleDialog: ({ schedule }: { schedule?: { name: string } | null }) => (
    <div data-testid="dialog">{schedule ? `editing ${schedule.name}` : 'creating'}</div>
  ),
}));
vi.mock('@weldsuite/ui/components/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    description: ReactNode;
    onConfirm: () => void;
  }) =>
    open ? (
      <div data-testid="confirm">
        <p>{title}</p>
        <p>{description}</p>
        <button type="button" onClick={onConfirm}>
          confirm delete
        </button>
      </div>
    ) : null,
}));

import DeskReportSchedulesPage from './page';

function schedule(overrides: Partial<HelpdeskReportScheduleDto> = {}): HelpdeskReportScheduleDto {
  return {
    id: 'sched_1',
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T08:00:00.000Z',
    name: 'Weekly overview',
    reportId: null,
    reportTitle: null,
    range: 'last_7_days',
    frequency: 'weekly',
    dayOfWeek: 1,
    dayOfMonth: null,
    hour: 8,
    timezone: 'Europe/Amsterdam',
    recipients: ['lead@example.com', 'ops@example.com'],
    attachCsv: true,
    locale: 'en',
    enabled: true,
    createdById: 'user_1',
    nextRunAt: '2026-11-16T07:00:00.000Z',
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    ...overrides,
  };
}

function loaded(rows: HelpdeskReportScheduleDto[]) {
  state.query = { data: rows, isLoading: false, isError: false, refetch: () => Promise.resolve() };
}

const ALL = ['settings:create', 'settings:update', 'settings:delete'];

beforeEach(() => {
  state.permissions = new Set(ALL);
  state.update = { mutate: vi.fn(), isPending: false };
  state.send = { mutate: vi.fn() };
  state.remove = { mutateAsync: vi.fn(() => Promise.resolve()) };
  state.toastSuccess = vi.fn();
  state.toastError = vi.fn();
  loaded([schedule()]);
});

afterEach(cleanup);

describe('DeskReportSchedulesPage list', () => {
  it('shows the overview with its period, the readable time, the recipients and the next run', () => {
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('Weekly overview')).toBeTruthy();
    expect(screen.getByText('Overview, Last 7 days')).toBeTruthy();
    expect(screen.getByText('Every Monday at 08:00 (Europe/Amsterdam)')).toBeTruthy();
    const recipients = screen.getByText('2 recipients');
    expect(recipients.getAttribute('title')).toBe('lead@example.com, ops@example.com');
    // Never run yet.
    expect(screen.getByText('Not run yet')).toBeTruthy();
  });

  it('shows the last run with a sent status', () => {
    loaded([schedule({ lastRunAt: '2026-11-09T07:00:00.000Z', lastStatus: 'sent' })]);
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.queryByText('Not run yet')).toBeNull();
  });

  it('shows a failed run with its error', () => {
    loaded([schedule({ lastRunAt: '2026-11-09T07:00:00.000Z', lastStatus: 'failed', lastError: 'Mailbox is full' })]);
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Mailbox is full')).toBeTruthy();
  });

  it('shows a disabled schedule as off, with its switch off', () => {
    loaded([schedule({ enabled: false, nextRunAt: null })]);
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('says when the saved report was deleted, with the reason the server gave', () => {
    loaded([
      schedule({
        reportId: 'rpt_gone',
        reportTitle: null,
        enabled: false,
        nextRunAt: null,
        lastStatus: 'failed',
        lastRunAt: '2026-11-09T07:00:00.000Z',
        lastError: 'The saved report no longer exists',
      }),
    ]);
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('Report was deleted')).toBeTruthy();
    expect(screen.getByText('The saved report no longer exists')).toBeTruthy();
  });

  it('names a saved report by its title', () => {
    loaded([schedule({ reportId: 'rpt_1', reportTitle: 'Escalations' })]);
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('Escalations')).toBeTruthy();
  });

  it('turns a schedule off with the switch', () => {
    render(<DeskReportSchedulesPage />);
    fireEvent.click(screen.getByRole('switch'));
    expect(state.update.mutate).toHaveBeenCalledWith({ id: 'sched_1', input: { enabled: false } }, expect.anything());
  });

  it('offers to create the first schedule when there are none', () => {
    loaded([]);
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('No scheduled reports')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New schedule' }));
    expect(screen.getByTestId('dialog').textContent).toBe('creating');
  });

  it('shows an error with retry when the list fails', () => {
    state.query = { data: undefined, isLoading: false, isError: true, refetch: () => Promise.resolve() };
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('Failed to load the scheduled reports')).toBeTruthy();
  });
});

describe('DeskReportSchedulesPage actions', () => {
  it('opens the edit dialog on the row', () => {
    render(<DeskReportSchedulesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Weekly overview' }));
    expect(screen.getByTestId('dialog').textContent).toBe('editing Weekly overview');
  });

  it('reports a successful send now', () => {
    state.send.mutate = vi.fn((_id, callbacks) => {
      callbacks.onSuccess?.({ status: 'sent' });
      callbacks.onSettled?.();
    });
    render(<DeskReportSchedulesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Send now: Weekly overview' }));
    expect(state.send.mutate).toHaveBeenCalledWith('sched_1', expect.anything());
    expect(state.toastSuccess).toHaveBeenCalledWith('Report sent to 2 recipients');
  });

  it('reports a failed send now with the reason', () => {
    state.send.mutate = vi.fn((_id, callbacks) => {
      callbacks.onSuccess?.({ status: 'failed', error: 'Mailbox is full' });
      callbacks.onSettled?.();
    });
    render(<DeskReportSchedulesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Send now: Weekly overview' }));
    expect(state.toastError).toHaveBeenCalledWith('Sending failed: Mailbox is full');
    expect(state.toastSuccess).not.toHaveBeenCalled();
  });

  it('reports a request that failed outright', () => {
    state.send.mutate = vi.fn((_id, callbacks) => {
      callbacks.onError?.();
      callbacks.onSettled?.();
    });
    render(<DeskReportSchedulesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Send now: Weekly overview' }));
    expect(state.toastError).toHaveBeenCalledWith('The report could not be sent');
  });

  it('asks before deleting, then deletes', async () => {
    render(<DeskReportSchedulesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete: Weekly overview' }));
    const confirm = screen.getByTestId('confirm');
    expect(within(confirm).getByText('Delete this schedule?')).toBeTruthy();
    expect(state.remove.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'confirm delete' }));
    await screen.findByText('Weekly overview');
    expect(state.remove.mutateAsync).toHaveBeenCalledWith('sched_1');
  });

  it('hides the actions the member may not use', () => {
    state.permissions = new Set(['settings:update']);
    render(<DeskReportSchedulesPage />);
    expect(screen.queryByRole('button', { name: 'New schedule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete: Weekly overview' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit: Weekly overview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send now: Weekly overview' })).toBeTruthy();
  });

  it('shows no write actions to a read-only member, and a locked switch', () => {
    state.permissions = new Set();
    render(<DeskReportSchedulesPage />);
    expect(screen.queryByRole('button', { name: 'New schedule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit: Weekly overview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send now: Weekly overview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete: Weekly overview' })).toBeNull();
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the create action in the empty state without settings:create', () => {
    state.permissions = new Set();
    loaded([]);
    render(<DeskReportSchedulesPage />);
    expect(screen.getByText('No scheduled reports')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New schedule' })).toBeNull();
  });
});
