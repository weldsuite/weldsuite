import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposeAttachButton } from './compose-attach-button';

describe('ComposeAttachButton', () => {
  it('opens the native file picker instead of showing a toast', async () => {
    const user = userEvent.setup();
    const onFilesSelected = vi.fn();
    render(<ComposeAttachButton title="Attach file" onFilesSelected={onFilesSelected} />);

    const input = screen.getByTestId('compose-attach-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    await user.click(screen.getByRole('button', { name: 'Attach file' }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(onFilesSelected).not.toHaveBeenCalled();
  });

  it('forwards selected files to the composer', async () => {
    const onFilesSelected = vi.fn();
    render(<ComposeAttachButton title="Attach file" onFilesSelected={onFilesSelected} />);

    const input = screen.getByTestId('compose-attach-input') as HTMLInputElement;
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    await userEvent.upload(input, file);

    expect(onFilesSelected).toHaveBeenCalledTimes(1);
    const received = onFilesSelected.mock.calls[0][0] as File[];
    expect(received).toHaveLength(1);
    expect(received[0].name).toBe('note.txt');
  });
});
