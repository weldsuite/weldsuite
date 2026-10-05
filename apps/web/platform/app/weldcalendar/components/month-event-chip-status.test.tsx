import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MonthEventChip } from './month-event-chip';

describe('MonthEventChip status', () => {
  it('draws a confirmed event plain', () => {
    render(<MonthEventChip color="#3b82f6" title="Standup" status="confirmed" />);
    expect(screen.getByRole('button')).not.toHaveAttribute('data-status');
    expect(screen.getByText('Standup')).not.toHaveClass('line-through');
  });

  it('strikes through and fades a cancelled event', () => {
    render(<MonthEventChip color="#3b82f6" title="Standup" status="cancelled" />);
    expect(screen.getByText('Standup')).toHaveClass('line-through');
    expect(screen.getByRole('button')).toHaveClass('opacity-60');
    expect(screen.getByRole('button')).toHaveAttribute('data-status', 'cancelled');
  });

  it('outlines and stripes a tentative event', () => {
    render(<MonthEventChip color="#3b82f6" title="Standup" status="tentative" />);
    const chip = screen.getByRole('button');
    expect(chip).toHaveClass('border-dashed');
    expect(chip.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(chip).toHaveAttribute('data-status', 'tentative');
    expect(screen.getByText('Standup')).not.toHaveClass('line-through');
  });

  it('lets the caller dim a cancelled chip further while dragging', () => {
    render(<MonthEventChip color="#3b82f6" title="Standup" status="cancelled" className="opacity-40" />);
    expect(screen.getByRole('button')).toHaveClass('opacity-40');
    expect(screen.getByRole('button')).not.toHaveClass('opacity-60');
  });
});
