import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrSelfAttendance } from '@weldsuite/app-api-client/domains/weldhr';

type Record = HrSelfAttendance['records'][number];

const mocks = vi.hoisted(() => ({ retry: vi.fn() }));
/** What the item query answers: the item, null (not in any period), undefined (still loading). */
let item: Record | null | undefined;
let error: unknown = null;

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-workspace-url', () => ({
  useWorkspaceUrl: () => (path: string) => `https://app.test${path}`,
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyAttendanceItem: () => ({ item, error, retry: mocks.retry }),
}));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('@/app/weldhr/me/components/schedule-hours-tab', () => ({
  RecordStatus: ({ record }: { record: { status: string } }) => <span>{`Status ${record.status}`}</span>,
}));

import { MyAttendancePanel } from './my-attendance-panel';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeRecord(extra: Partial<Record> = {}): Record {
  return {
    id: 'att_1',
    date: '2026-06-01',
    clockIn: '2026-06-01T08:05:00',
    clockOut: '2026-06-01T16:30:00',
    breakMinutes: 30,
    workedMinutes: 475,
    lateMinutes: 5,
    status: 'late',
    source: 'web',
    approved: true,
    companyName: 'Acme BV',
    notes: 'Traffic',
    hourlyRate: 15,
    currency: 'EUR',
    ...extra,
  };
}

function renderPanel() {
  return renderWithProviders(<MyAttendancePanel id="att_1" isOpen onClose={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  item = makeRecord();
  error = null;
});

describe('MyAttendancePanel', () => {
  it('shows the clock record with its times, break, worked time, client, rate and notes', () => {
    renderPanel();
    expect(screen.getByText('08:05')).toBeInTheDocument();
    expect(screen.getByText('16:30')).toBeInTheDocument();
    expect(screen.getByText('Acme BV')).toBeInTheDocument();
    expect(screen.getByText('Traffic')).toBeInTheDocument();
    expect(screen.getByText('Status late')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText(/15/)).toBeInTheDocument();
  });

  it('shows dashes and the approval wait for an open, unapproved record without optional fields', () => {
    item = makeRecord({
      clockIn: null,
      clockOut: null,
      breakMinutes: null,
      workedMinutes: null,
      lateMinutes: null,
      status: 'present',
      approved: false,
      companyName: null,
      notes: undefined,
      hourlyRate: null,
      currency: null,
    });
    renderPanel();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(5);
  });

  it('shows no late row when the record is on time', () => {
    item = makeRecord({ lateMinutes: 0, status: 'present' });
    renderPanel();
    expect(screen.queryByText('Late')).not.toBeInTheDocument();
  });

  it('copies a link from the menu of the record', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /copy link/i }));
    expect(write).toHaveBeenCalledWith('https://app.test/weldhr/me/schedule?stack=hr_my_attendance:att_1');
  });

  it('says so when the record is in none of the periods', () => {
    item = null;
    renderPanel();
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
  });

  it('shows the error with Try again when a period failed', async () => {
    item = undefined;
    error = new Error('Server unavailable');
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.retry).toHaveBeenCalled();
  });

  it('shows nothing of the record while loading', () => {
    item = undefined;
    renderPanel();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme BV')).not.toBeInTheDocument();
  });
});
