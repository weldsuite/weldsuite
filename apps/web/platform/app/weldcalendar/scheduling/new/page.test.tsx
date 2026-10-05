/**
 * Booking page editor (TASK-892): the scheduling window, daily limit and
 * adjusted dates are controlled, shown in the section summaries, and carried
 * into the create draft / edit payload.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useBlocker: () => ({ proceed: undefined, reset: undefined, status: 'idle' }),
}));
vi.mock('@/hooks/queries/use-calendar-queries', () => ({
  useCreateBookingPage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/components/entity-list', () => ({ FilterPills: () => null }));
// The week preview reads the 12h/24h preference; undefined means 12h.
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useUserPreferences: () => ({ data: undefined }),
}));

import { BookingPageEditor } from './page';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

const storedPage = {
  title: 'Intro call',
  duration: 30,
  availability: {
    monday: [{ start: '09:00', end: '17:00' }],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  },
  bufferBefore: 5,
  bufferAfter: 10,
  minNotice: 90,
  maxAdvance: 30,
  dateOverrides: [{ date: '2026-12-24', slots: [] }],
  maxBookingsPerDay: 4,
};

function openSection(title: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }));
}

describe('BookingPageEditor settings', () => {
  it('starts from the real stored defaults, not the old hard-coded 4 hours', () => {
    render(<BookingPageEditor mode="create" />);
    expect(screen.getByText('60 days in advance · 1 hour before')).toBeInTheDocument();
    openSection('Scheduling window');
    expect(screen.getByLabelText('Minimum notice')).toHaveValue('1');
    expect(screen.getByLabelText('Maximum advance booking')).toHaveValue('60');
  });

  it('starts from the stored page when editing and shows it in the summaries', () => {
    render(<BookingPageEditor mode="edit" bookingPageId="bpg_1" initialData={storedPage} />);
    expect(screen.getByText('30 days in advance · 90 minutes before')).toBeInTheDocument();
    expect(screen.getByText('5 min before, 10 min after · Max 4 per day')).toBeInTheDocument();
    expect(screen.getByText('1 adjusted date')).toBeInTheDocument();
    openSection('Scheduling window');
    expect(screen.getByLabelText('Minimum notice')).toHaveValue('1.5');
    openSection('Booked appointment settings');
    expect(screen.getByLabelText('Max bookings per day')).toHaveValue('4');
  });

  it('updates the summary and the draft when the settings change', () => {
    render(<BookingPageEditor mode="create" />);
    openSection('Scheduling window');
    fireEvent.change(screen.getByLabelText('Minimum notice'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Maximum advance booking'), { target: { value: '14' } });
    openSection('Booked appointment settings');
    fireEvent.change(screen.getByLabelText('Max bookings per day'), { target: { value: '6' } });

    expect(screen.getByText('14 days in advance · 4 hours before')).toBeInTheDocument();
    expect(screen.getByText(/Max 6 per day/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const draft = JSON.parse(sessionStorage.getItem('booking-new-draft') ?? '{}');
    expect(draft).toMatchObject({
      minNotice: 240,
      maxAdvance: 14,
      maxBookingsPerDay: 6,
      dateOverrides: [],
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/weldcalendar/scheduling/$id', params: { id: '__draft__' } });
  });

  it('keeps unusable input out of the settings and reverts it on blur', () => {
    render(<BookingPageEditor mode="create" />);
    openSection('Scheduling window');
    const advance = screen.getByLabelText('Maximum advance booking');
    fireEvent.change(advance, { target: { value: '0' } });
    expect(screen.getByText(/^60 days in advance/)).toBeInTheDocument();
    fireEvent.change(advance, { target: { value: '' } });
    fireEvent.blur(advance);
    expect(advance).toHaveValue('60');
  });

  it('writes the edit payload with every setting', () => {
    render(<BookingPageEditor mode="edit" bookingPageId="bpg_1" initialData={storedPage} />);
    openSection('Booked appointment settings');
    fireEvent.change(screen.getByLabelText('Max bookings per day'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    const pending = JSON.parse(sessionStorage.getItem('booking-edit-bpg_1') ?? '{}');
    expect(pending).toMatchObject({
      name: 'Intro call',
      minNotice: 90,
      maxAdvance: 30,
      dateOverrides: [{ date: '2026-12-24', slots: [] }],
      maxBookingsPerDay: null,
    });
  });

  it('blocks Continue while an adjusted date ends before it starts', () => {
    render(
      <BookingPageEditor
        mode="edit"
        bookingPageId="bpg_1"
        initialData={{
          ...storedPage,
          dateOverrides: [{ date: '2026-12-24', slots: [{ start: '18:00', end: '17:00' }] }],
        }}
      />,
    );
    openSection('Adjusted availability');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('End time must be after the start time');
    // Repair the range and Next works again.
    const section = screen.getByRole('alert').closest('div.divide-y') as HTMLElement;
    const times = within(section).getAllByDisplayValue(/^\d\d:\d\d$/);
    fireEvent.change(times[1], { target: { value: '19:00' } });
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });
});
