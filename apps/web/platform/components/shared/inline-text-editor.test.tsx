import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InlineTextEditor } from './inline-text-editor';

describe('InlineTextEditor editRequest', () => {
  it('stays idle on mount and opens the editor when the request is bumped', () => {
    const onSave = vi.fn();
    const { rerender } = render(<InlineTextEditor value="Task title" onSave={onSave} editRequest={0} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    rerender(<InlineTextEditor value="Task title" onSave={onSave} editRequest={1} />);
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveFocus();

    fireEvent.change(textarea, { target: { value: 'Renamed' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('Renamed');
  });
});
