import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CopyButton } from './copy-button';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
}

function renderButton() {
  render(<CopyButton value="forms.weldsuite.eu" label="Copy CNAME value" copiedLabel="Copied" failedLabel="Copy failed" feedbackMs={1000} />);
  return screen.getByRole('button', { name: 'Copy CNAME value' });
}

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
  });
}

describe('CopyButton', () => {
  it('copies its value and announces it, then clears the message', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const button = renderButton();

    await click(button);
    expect(writeText).toHaveBeenCalledWith('forms.weldsuite.eu');
    expect(screen.getByRole('status').textContent).toBe('Copied');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('announces a failure, and a repeat differently so screen readers read it again', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    const button = renderButton();

    await click(button);
    const first = screen.getByRole('status').textContent;
    expect(first).toBe('Copy failed');
    await click(button);
    const second = screen.getByRole('status').textContent;
    expect(second?.trim()).toBe('Copy failed');
    expect(second).not.toBe(first);
    // The button stays usable while the feedback shows.
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('falls back to the legacy copy command when the async clipboard refuses', async () => {
    stubClipboard(() => Promise.reject(new Error('insecure context')));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    const button = renderButton();

    await click(button);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('status').textContent).toBe('Copied');
  });

  it('shows its label as text with showLabel, and is named by it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<CopyButton value="https://x.test/d/1" label="Copy link" showLabel copiedLabel="Copied" failedLabel="Copy failed" />);
    const button = screen.getByRole('button', { name: 'Copy link' });
    expect(button.textContent).toBe('Copy link');
    expect(button.hasAttribute('aria-label')).toBe(false);

    await click(button);
    expect(writeText).toHaveBeenCalledWith('https://x.test/d/1');
    expect(screen.getByRole('status').textContent).toBe('Copied');
  });
});
