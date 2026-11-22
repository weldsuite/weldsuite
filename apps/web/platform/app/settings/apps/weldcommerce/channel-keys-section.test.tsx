import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelKey } from '@/hooks/queries/use-commerce-channels-queries';

const env = vi.hoisted(() => ({
  keys: { data: { data: [] as unknown[] }, isPending: false, isError: false, refetch: vi.fn() },
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-commerce-channels-queries', () => ({
  useChannelKeys: () => env.keys,
  useCreateChannelKey: () => ({ mutateAsync: env.create }),
  useUpdateChannelKey: () => ({ mutateAsync: env.update }),
  useRotateChannelKey: () => ({ mutateAsync: env.rotate }),
  useRevokeChannelKey: () => ({ mutateAsync: env.revoke }),
}));

import { ChannelKeysSection } from './channel-keys-section';

const key = (over: Partial<ChannelKey> = {}): ChannelKey => ({
  id: 'k1',
  channelId: 'ch_1',
  kind: 'publishable',
  name: 'Website',
  keyPrefix: 'wcp_live_3f9a1234',
  allowedOrigins: ['https://shop.example.com'],
  createdAt: '2026-11-01T10:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
  rotatedFromId: null,
  ...over,
});

// Radix Select reads pointer capture and scrolls the chosen option into view; jsdom has neither.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.keys = { data: { data: [key()] }, isPending: false, isError: false, refetch: vi.fn() };
  for (const fn of [env.create, env.update, env.rotate, env.revoke]) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ChannelKeysSection', () => {
  it('lists a key by its prefix, never a secret, with its origins and state', () => {
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    expect(screen.getByText('Website')).toBeTruthy();
    expect(screen.getByText('wcp_live_3f9a1234…')).toBeTruthy();
    expect(screen.getByText('https://shop.example.com')).toBeTruthy();
    expect(screen.getByText('Never')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('marks a revoked key and offers no actions on it', () => {
    env.keys = { ...env.keys, data: { data: [key({ revokedAt: '2026-11-10T10:00:00Z' })] } };
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    expect(screen.getByText(/Revoked/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rotate key/ })).toBeNull();
  });

  it('hides the writes from a member who may only read', () => {
    render(<ChannelKeysSection channelId="ch_1" canUpdate={false} />);
    expect(screen.queryByRole('button', { name: 'New key' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Rotate key/ })).toBeNull();
  });

  it('shows an empty state with the create button, a loader and a retryable error', async () => {
    env.keys = { ...env.keys, data: { data: [] } };
    const { unmount } = render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    expect(screen.getByText('No keys yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New key' })).toBeTruthy();
    unmount();

    env.keys = { ...env.keys, isError: true };
    const user = userEvent.setup();
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.keys.refetch).toHaveBeenCalled();
  });

  it('creates a publishable key and shows its secret once, in a dialog that has to be dismissed', async () => {
    env.create.mockResolvedValue({ data: { key: key({ id: 'k2', name: 'Shop' }), secret: 'wcp_SECRET123' } });
    const user = userEvent.setup();
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(screen.getByLabelText('Name'), 'Shop');
    await user.type(screen.getByLabelText('Allowed origins'), 'https://shop.example.com');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() =>
      expect(env.create).toHaveBeenCalledWith({
        channelId: 'ch_1',
        data: { kind: 'publishable', name: 'Shop', allowedOrigins: ['https://shop.example.com'] },
      }),
    );
    expect(await screen.findByTestId('key-secret')).toHaveValue('wcp_SECRET123');
    await user.click(screen.getByRole('button', { name: 'I have copied it' }));
    await waitFor(() => expect(screen.queryByTestId('key-secret')).toBeNull());
  });

  it('refuses a publishable key without a valid origin', async () => {
    const user = userEvent.setup();
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    await user.click(screen.getByRole('button', { name: 'New key' }));
    await user.type(screen.getByLabelText('Name'), 'Shop');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('Add at least one origin.')).toBeTruthy();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('rotates after a confirmation and shows the new secret', async () => {
    env.rotate.mockResolvedValue({ data: { key: key({ id: 'k3' }), secret: 'wcp_ROTATED' } });
    const user = userEvent.setup();
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    await user.click(screen.getByRole('button', { name: 'Rotate key Website' }));
    expect(env.rotate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(env.rotate).toHaveBeenCalledWith({ channelId: 'ch_1', keyId: 'k1' }));
    expect(await screen.findByTestId('key-secret')).toHaveValue('wcp_ROTATED');
  });

  it('revokes after a confirmation', async () => {
    env.revoke.mockResolvedValue({ data: key() });
    const user = userEvent.setup();
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    await user.click(screen.getByRole('button', { name: 'Revoke key Website' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(env.revoke).toHaveBeenCalledWith({ channelId: 'ch_1', keyId: 'k1' }));
    expect(toast.success).toHaveBeenCalledWith('Key revoked');
  });

  it('edits the name and the origins of a key', async () => {
    env.update.mockResolvedValue({ data: key() });
    const user = userEvent.setup();
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    await user.click(screen.getByRole('button', { name: 'Edit key Website' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Main site');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(env.update).toHaveBeenCalledWith({
        channelId: 'ch_1',
        keyId: 'k1',
        data: { name: 'Main site', allowedOrigins: ['https://shop.example.com'] },
      }),
    );
  });

  it('shows a failed revoke in a toast', async () => {
    env.revoke.mockRejectedValue(new Error('Server on fire'));
    const user = userEvent.setup();
    render(<ChannelKeysSection channelId="ch_1" canUpdate />);
    await user.click(screen.getByRole('button', { name: 'Revoke key Website' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server on fire'));
  });
});
