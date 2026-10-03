import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';
import { AllDayRow } from './all-day-row';

const day = (d: number, h = 0, m = 0, s = 0) => new Date(2026, 9, d, h, m, s);
const week = Array.from({ length: 7 }, (_, i) => day(5 + i));

const trip: CalendarEvent = {
  id: 'trip',
  type: 'event',
  title: 'Team offsite',
  allDay: true,
  startTime: day(6).toISOString(),
  endTime: day(8, 23, 59, 59).toISOString(),
};
const standup: CalendarEvent = {
  id: 'standup',
  type: 'meeting',
  title: 'Standup',
  startTime: day(6, 9).toISOString(),
  endTime: day(6, 9, 15).toISOString(),
};

function renderRow(events: CalendarEvent[], onSelectEvent = vi.fn(), days = week) {
  render(
    <AllDayRow
      days={days}
      events={events}
      getColor={() => '#3b82f6'}
      onSelectEvent={onSelectEvent}
      allDayLabel="All day"
      autoScheduledLabel="Auto-scheduled"
    />,
  );
  return onSelectEvent;
}

describe('AllDayRow', () => {
  it('shows the all-day label even when there are no all-day events', () => {
    renderRow([standup]);
    expect(screen.getByText('All day')).toBeInTheDocument();
    expect(screen.queryByText('Standup')).toBeNull();
  });

  it('renders a multi-day event as one bar spanning the days it covers', () => {
    renderRow([trip]);
    const bar = screen.getByRole('button', { name: /Team offsite/ });
    expect(screen.getAllByText('Team offsite')).toHaveLength(1);
    // Mon 5 is column 2; the bar starts on Tue 6 (grid col 3) and covers three days.
    expect(bar.parentElement).toHaveStyle({ gridColumn: '3 / 6' });
  });

  it('opens the event through the shared select handler', () => {
    const onSelect = renderRow([trip]);
    fireEvent.click(screen.getByRole('button', { name: /Team offsite/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(trip);
  });

  it('flattens the edges of a bar that continues outside the visible days', () => {
    renderRow([trip], vi.fn(), [day(7), day(8), day(9), day(10)]);
    const bar = screen.getByRole('button', { name: /Team offsite/ });
    expect(bar).toHaveClass('rounded-l-none');
    expect(bar).not.toHaveClass('rounded-r-none');
  });

  it('marks auto-scheduled events', () => {
    renderRow([{ ...trip, autoScheduled: true }]);
    expect(screen.getByRole('img', { name: 'Auto-scheduled' })).toBeInTheDocument();
  });
});
