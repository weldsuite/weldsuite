import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FigureRow } from './figure-row';

const ITEMS = [
  { key: 'rage', label: 'Rage clicks', value: '120', note: '+20%', warn: true },
  { key: 'dead', label: 'Dead clicks', value: '45' },
];

describe('FigureRow', () => {
  afterEach(cleanup);

  it('shows each figure with its note', () => {
    render(<FigureRow items={ITEMS} />);
    expect(screen.getByText('Rage clicks')).toBeTruthy();
    expect(screen.getByText('+20%').className).toContain('text-destructive');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('picks a figure when it is given onSelect, marking the selected one', () => {
    const onSelect = vi.fn();
    render(<FigureRow items={ITEMS} onSelect={onSelect} selected="rage" label="Signals" columns={5} />);
    const group = screen.getByRole('group', { name: 'Signals' });
    expect(group.className).toContain('lg:grid-cols-5');
    expect(screen.getByRole('button', { name: /Rage clicks/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Dead clicks/ }));
    expect(onSelect).toHaveBeenCalledWith('dead');
  });

  it('shows placeholders while loading', () => {
    const { container } = render(<FigureRow items={ITEMS} loading />);
    expect(screen.queryByText('120')).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
  });
});
