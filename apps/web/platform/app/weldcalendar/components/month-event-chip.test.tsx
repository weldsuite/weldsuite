import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MonthEventChip, MonthMoreButton } from './month-event-chip';

describe('MonthEventChip', () => {
  it('renders the time and the title as separate elements', () => {
    render(<MonthEventChip color="#3b82f6" time="5:10" title="Design homepage mockups for the launch" />);

    const time = screen.getByText('5:10');
    const title = screen.getByText('Design homepage mockups for the launch');
    expect(time).not.toBe(title);
    expect(time.parentElement).toBe(title.parentElement);
  });

  it('never shrinks the time, only the title', () => {
    render(<MonthEventChip color="#3b82f6" time="5:10" title="Design homepage mockups for the launch" />);

    expect(screen.getByText('5:10')).toHaveClass('shrink-0');
    const title = screen.getByText('Design homepage mockups for the launch');
    expect(title).toHaveClass('truncate');
    expect(title).toHaveClass('min-w-0');
  });

  it('left-aligns its content so an overflowing title cannot clip the time', () => {
    render(<MonthEventChip color="#3b82f6" time="5:10" title="Long title" />);
    expect(screen.getByRole('button')).toHaveClass('justify-start');
  });

  it('omits the time for all-day events', () => {
    render(<MonthEventChip color="#3b82f6" time={null} title="Company offsite" />);
    expect(screen.getByRole('button')).toHaveTextContent('Company offsite');
    expect(document.querySelector('[data-slot="chip-time"]')).toBeNull();
  });
});

describe('MonthMoreButton', () => {
  it('renders the label and reports clicks', () => {
    const onClick = vi.fn();
    render(<MonthMoreButton label="+3 more" onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: '+3 more' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
