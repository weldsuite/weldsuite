import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrSelfAttendance } from '@weldsuite/app-api-client/domains/weldhr';

type Shift = HrSelfAttendance['shifts'][number];

const mocks = vi.hoisted(() => ({ retry: vi.fn() }));
/** What the item query answers: the item, null (not in any period), undefined (still loading). */
let item: Shift | null | undefined;
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
vi.mock('@/app/weldhr/me/components/schedule-shifts-tab', () => ({
  plannedHours: () => '7.5',
}));

import { MyShiftPanel } from './my-shift-panel';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeShift(extra: Partial<Shift> = {}): Shift {
  return {
    id: 'shift_1',
    startsAt: '2026-06-01T08:00:00',
    endsAt: '2026-06-01T16:30:00',
    companyName: 'Acme BV',
    notes: 'Bring the keys',
    workType: 'Cashier',
    breakStartsAt: '2026-06-01T12:00:00',
    breakEndsAt: '2026-06-01T13:00:00',
    hourlyRate: 15,
    currency: 'EUR',
    ...extra,
  };
}

function renderPanel() {
  return renderWithProviders(<MyShiftPanel id="shift_1" isOpen onClose={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  item = makeShift();
  error = null;
});

describe('MyShiftPanel', () => {
  it('shows the shift with its times, break, planned hours, client and rate', () => {
    renderPanel();
    expect(screen.getAllByText('Cashier').length).toBeGreaterThan(0);
    expect(screen.getByText('08:00 – 16:30')).toBeInTheDocument();
    expect(screen.getByText('12:00 – 13:00')).toBeInTheDocument();
    expect(screen.getByText('Acme BV')).toBeInTheDocument();
    expect(screen.getByText('Bring the keys')).toBeInTheDocument();
    expect(screen.getByText(/15/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
  });

  it('falls back to a generic title and dashes without work type, break, rate and notes', () => {
    item = makeShift({
      workType: undefined,
      breakStartsAt: null,
      breakEndsAt: null,
      hourlyRate: null,
      currency: null,
      notes: null,
      companyName: null,
    });
    renderPanel();
    expect(screen.getByText('Shift')).toBeInTheDocument();
    expect(screen.queryByText('12:00 – 13:00')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('shows no rate when only the currency or only the amount is known', () => {
    item = makeShift({ hourlyRate: 15, currency: null });
    renderPanel();
    expect(screen.queryByText(/per hour|\/ hour|\/h/i)).not.toBeInTheDocument();
  });

  it('copies a link from the menu of the shift', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /copy link/i }));
    expect(write).toHaveBeenCalledWith('https://app.test/weldhr/me/schedule?stack=hr_my_shift:shift_1');
  });

  it('says so when the shift is in none of the periods', () => {
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

  it('shows nothing of the shift while loading', () => {
    item = undefined;
    renderPanel();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Cashier')).not.toBeInTheDocument();
  });
});
