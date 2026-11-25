import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ComposerNotice } from './composer';

afterEach(cleanup);

describe('ComposerNotice', () => {
  it('shows what the next message is about, with its icon and actions', () => {
    render(
      <ComposerNotice
        icon={<svg data-testid="reply-icon" />}
        actions={<button type="button">Jump to message</button>}
        className="mx-2"
        data-testid="notice"
      >
        Replying to Ann
      </ComposerNotice>,
    );
    const notice = screen.getByTestId('notice');
    expect(notice.dataset.slot).toBe('composer-notice');
    expect(notice.className).toContain('mx-2');
    expect(screen.getByText('Replying to Ann')).toBeTruthy();
    expect(screen.getByTestId('reply-icon')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Jump to message' })).toBeTruthy();
  });

  it('has no close button without onDismiss', () => {
    render(<ComposerNotice>Editing a message</ComposerNotice>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('closes with a button named by dismissLabel', () => {
    const onDismiss = vi.fn();
    render(
      <ComposerNotice onDismiss={onDismiss} dismissLabel="Cancel reply">
        Replying to Ann
      </ComposerNotice>,
    );
    const close = screen.getByRole('button', { name: 'Cancel reply' });
    expect(close.getAttribute('title')).toBe('Cancel reply');
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
