import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SegmentedControl } from './segmented-control';

const options = [
  { value: 'project', label: 'Per project' },
  { value: 'person', label: 'Per person' },
  { value: 'entry', label: 'Every entry' },
] as const;

describe('SegmentedControl', () => {
  afterEach(cleanup);

  it('names the group and marks the selected segment', () => {
    render(<SegmentedControl options={options} value="person" onChange={() => {}} ariaLabel="Group the lines" />);
    expect(screen.getByRole('group', { name: 'Group the lines' })).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Per person' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Per project' }).getAttribute('aria-checked')).toBe('false');
  });

  it('reports the segment that is pressed', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={options} value="project" onChange={onChange} ariaLabel="Group" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Every entry' }));
    expect(onChange).toHaveBeenCalledWith('entry');
  });

  it('keeps the selected segment when it is pressed again', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={options} value="project" onChange={onChange} ariaLabel="Group" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Per project' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
