import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelKeySecret } from '@/hooks/queries/use-commerce-channels-queries';
import { SecretDialog } from './secret-dialog';

const secret: ChannelKeySecret = {
  secret: 'wcs_ABCDEF123456',
  key: {
    id: 'k1',
    channelId: 'ch_1',
    kind: 'private',
    name: 'Server',
    keyPrefix: 'wcs_live_ABCDEF12',
    allowedOrigins: [],
    createdAt: '2026-11-20T10:00:00Z',
    lastUsedAt: null,
    revokedAt: null,
    rotatedFromId: null,
  },
};

describe('SecretDialog', () => {
  it('shows the secret and says it will not be shown again', () => {
    render(<SecretDialog secret={secret} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Your new key' })).toBeTruthy();
    expect(screen.getByTestId('key-secret')).toHaveValue('wcs_ABCDEF123456');
    expect(screen.getByText('You will not see this key again.')).toBeTruthy();
  });

  it('shows nothing without a secret', () => {
    render(<SecretDialog secret={null} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not close on Escape or a click outside, only with the button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SecretDialog secret={secret} onClose={onClose} />);
    await user.keyboard('{Escape}');
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says it is the replacement when rotated', () => {
    render(<SecretDialog secret={secret} rotated onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Your new key replaces the old one' })).toBeTruthy();
    expect(screen.getByText('The old key no longer works.')).toBeTruthy();
  });

  it('copies the secret and says so in a status region, staying enabled', async () => {
    const user = userEvent.setup();
    render(<SecretDialog secret={secret} onClose={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Copy the secret of Server' });
    await user.click(button);
    expect(await navigator.clipboard.readText()).toBe('wcs_ABCDEF123456');
    expect(screen.getByRole('status').textContent).toBe('Copied');
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('says so when the copy fails', async () => {
    const user = userEvent.setup();
    render(<SecretDialog secret={secret} onClose={vi.fn()} />);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy the secret of Server' }));
    expect(screen.getByRole('status').textContent).toBe('Copy failed');
  });
});
