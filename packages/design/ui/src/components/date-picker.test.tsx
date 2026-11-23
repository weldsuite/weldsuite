import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { nl } from 'date-fns/locale';
import { DatePicker } from './date-picker';

afterEach(cleanup);

const NOV_26 = new Date(2026, 10, 26);

describe('DatePicker', () => {
  it('shows the placeholder while no date is picked', () => {
    render(<DatePicker placeholder="Start date" />);
    expect(screen.getByRole('button', { name: 'Start date' }).className).toContain('text-muted-foreground');
  });

  it('labels the picked date with date-fns "PPP" in the given locale', () => {
    const { rerender } = render(<DatePicker date={NOV_26} />);
    expect(screen.getByRole('button', { name: 'November 26th, 2026' })).toBeTruthy();
    rerender(<DatePicker date={NOV_26} locale={nl} />);
    expect(screen.getByRole('button', { name: '26 november 2026' })).toBeTruthy();
  });

  it("labels the picked date with formatDate, the app's own format", () => {
    const formatDate = vi.fn(() => 'Thu, 26 Nov 2026');
    render(<DatePicker date={NOV_26} formatDate={formatDate} />);
    expect(screen.getByRole('button', { name: 'Thu, 26 Nov 2026' })).toBeTruthy();
    expect(formatDate).toHaveBeenCalledWith(NOV_26);
  });

  it("doesn't let a disabled day be picked", () => {
    const onDateChange = vi.fn();
    render(<DatePicker date={NOV_26} onDateChange={onDateChange} disabledDays={{ before: NOV_26 }} />);
    fireEvent.click(screen.getByRole('button'));

    const yesterday = screen.getByText('25').closest('button');
    expect(yesterday?.disabled).toBe(true);
    fireEvent.click(screen.getByText('27'));
    expect(onDateChange).toHaveBeenCalledWith(new Date(2026, 10, 27));
  });

  it('puts month and year menus in the caption with captionLayout="dropdown"', () => {
    render(
      <DatePicker
        date={NOV_26}
        captionLayout="dropdown"
        startMonth={new Date(1950, 0)}
        endMonth={new Date(2026, 11)}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });
});
