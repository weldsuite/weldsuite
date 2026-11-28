import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CopyButton } from './copy-button';

const props = { value: 'https://x.test/d/1', copiedLabel: 'Copied', failedLabel: 'Copy failed', label: 'Copy link' };

describe('CopyButton', () => {
  const writeText = vi.fn();
  beforeEach(() => {
    writeText.mockReset();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(cleanup);

  it('copies the value and says so in a status message', async () => {
    writeText.mockResolvedValue(undefined);
    render(<CopyButton {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Copied'));
    expect(writeText).toHaveBeenCalledWith('https://x.test/d/1');
    // Never disabled while the confirmation shows: copying again is harmless.
    expect((screen.getByRole('button', { name: 'Copy link' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    render(<CopyButton {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Copy failed'));
  });

  it('names an icon-only button by its aria label', () => {
    render(<CopyButton {...props} label={undefined} ariaLabel="Copy the payment link" />);
    expect(screen.getByRole('button', { name: 'Copy the payment link' })).not.toBeNull();
  });
});
