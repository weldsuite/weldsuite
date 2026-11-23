import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TimePicker } from './time-picker';

beforeAll(() => {
  // Radix ScrollArea measures its viewport; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

/** Opens the picker from its trigger, the only button before it opens. */
function open() {
  fireEvent.click(screen.getByRole('button'));
}

/** On a 24-hour clock "09" is both an hour and a minute: the hour column comes first. */
function option(name: string, column: 'hour' | 'minute'): HTMLElement {
  const matches = screen.getAllByRole('button', { name });
  const match = column === 'hour' ? matches[0] : matches.at(-1);
  if (!match) throw new Error(`No ${column} option ${name}`);
  return match;
}
const hourOption = (name: string) => option(name, 'hour');
const minuteOption = (name: string) => option(name, 'minute');

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('TimePicker', () => {
  it('shows the placeholder while no time is set', () => {
    render(<TimePicker placeholder="Pick a time" />);
    const trigger = screen.getByRole('button', { name: 'Pick a time' });
    expect(trigger.className).toContain('text-muted-foreground');
  });

  it('reads the time on a 12-hour clock by default', () => {
    const { rerender } = render(<TimePicker value="14:30" />);
    expect(screen.getByRole('button', { name: '2:30 PM' })).toBeTruthy();
    rerender(<TimePicker value="00:05" />);
    expect(screen.getByRole('button', { name: '12:05 AM' })).toBeTruthy();
    rerender(<TimePicker value="09:15" />);
    expect(screen.getByRole('button', { name: '9:15 AM' })).toBeTruthy();
  });

  it('reads the time on a 24-hour clock, and lists 24-hour hours', () => {
    render(<TimePicker value="07:45" hourCycle={24} />);
    expect(screen.getByRole('button', { name: '07:45' }).className).not.toContain('text-muted-foreground');
    open();
    expect(hourOption('00')).toBeTruthy();
    expect(hourOption('23')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '23' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '12 PM' })).toBeNull();
  });

  it('lists the hours as AM and PM on a 12-hour clock, with the column headings given', () => {
    render(<TimePicker hourLabel="Uur" minuteLabel="Minuut" />);
    open();
    expect(screen.getByText('Uur')).toBeTruthy();
    expect(screen.getByText('Minuut')).toBeTruthy();
    expect(screen.getByRole('button', { name: '12 AM' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 PM' })).toBeTruthy();
  });

  it('uses English column headings when none are given', () => {
    render(<TimePicker />);
    open();
    expect(screen.getByText('Hour')).toBeTruthy();
    expect(screen.getByText('Min')).toBeTruthy();
  });

  it('starts at minute 00 when an hour is picked on an empty field', () => {
    const onChange = vi.fn();
    render(<TimePicker hourCycle={24} onChange={onChange} />);
    open();
    fireEvent.click(hourOption('09'));
    expect(onChange).toHaveBeenCalledWith('09:00');
  });

  it('starts at hour 00 when a minute is picked on an empty field', () => {
    const onChange = vi.fn();
    render(<TimePicker hourCycle={24} onChange={onChange} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: '30' }));
    expect(onChange).toHaveBeenCalledWith('00:30');
  });

  it('keeps the other part of the time when one part changes', () => {
    const onChange = vi.fn();
    render(<TimePicker value="14:30" hourCycle={24} onChange={onChange} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: '45' }));
    expect(onChange).toHaveBeenLastCalledWith('14:45');
    fireEvent.click(hourOption('08'));
    expect(onChange).toHaveBeenLastCalledWith('08:30');
  });

  it('marks the picked hour and minute, and scrolls them into view on open', async () => {
    render(<TimePicker value="14:30" hourCycle={24} />);
    open();
    const hour = hourOption('14');
    const minute = minuteOption('30');
    expect(hour.dataset.selected).toBe('true');
    expect(minute.dataset.selected).toBe('true');
    expect(minuteOption('14').dataset.selected).toBe('false');
    expect(hourOption('15').dataset.selected).toBe('false');

    const viewport = hour.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    if (viewport) viewport.scrollTop = 999;
    await nextFrame();
    // jsdom lays nothing out, so every offset is 0 and the column scrolls to 0.
    expect(viewport?.scrollTop).toBe(0);
  });

  it('empties an optional time with Clear, and closes', () => {
    const onChange = vi.fn();
    render(<TimePicker value="12:30" clearable clearLabel="Wissen" onChange={onChange} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Wissen' }));
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.queryByText('Hour')).toBeNull();
  });

  it('has an English Clear when no label is given', () => {
    render(<TimePicker value="12:30" clearable />);
    open();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('has no Clear while an optional time is empty, nor on a time the form needs', () => {
    const { unmount } = render(<TimePicker clearable />);
    open();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    unmount();

    render(<TimePicker value="12:30" />);
    open();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('passes other props to the trigger, so a form control can name it', () => {
    render(<TimePicker id="break-start" aria-invalid className="w-40" />);
    const trigger = screen.getByRole('button');
    expect(trigger.id).toBe('break-start');
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    expect(trigger.className).toContain('w-40');
  });
});
