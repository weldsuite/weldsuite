import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { makeKey } from '../observe-fixtures';
import { makeProject } from '../test-fixtures';
import { KeysTab } from './keys-tab';

const state = vi.hoisted(() => ({
  keys: { data: undefined as unknown, isLoading: false, error: null as unknown, refetch: vi.fn() },
  create: vi.fn(),
  revoke: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjectKeys: () => state.keys,
  useCreateWeldPanelKey: () => ({ mutateAsync: state.create, isPending: false }),
  useRevokeWeldPanelKey: () => ({ mutateAsync: state.revoke, isPending: false }),
}));

const tk = en.weldpanel.observe.keys;
const project = makeProject({ id: 'wpp_1' });

describe('Server keys tab', () => {
  beforeEach(() => {
    state.keys = { data: [makeKey(), makeKey({ id: 'wpkey_2', name: 'old', prefix: 'wps_zz99', revokedAt: '2026-11-10T00:00:00Z', lastUsedAt: '2026-11-09T12:00:00Z' })], isLoading: false, error: null, refetch: vi.fn() };
    state.create.mockReset();
    state.revoke.mockReset();
    state.toast.success.mockReset();
    state.toast.error.mockReset();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('lists the keys by their start only, with status and last use', () => {
    render(<KeysTab project={project} />);
    expect(screen.getByText('wps_ab12…')).toBeTruthy();
    expect(screen.getByText(tk.neverUsed)).toBeTruthy();
    expect(screen.getByText(tk.active)).toBeTruthy();
    expect(screen.getByText('Revoked Nov 10, 2026')).toBeTruthy();
    // Only the active key can be revoked.
    expect(screen.getAllByRole('button', { name: tk.revoke })).toHaveLength(1);
  });

  it('creates a key and shows the whole key once, with a copy button', async () => {
    state.create.mockResolvedValue({ ...makeKey({ id: 'wpkey_3', name: 'billing' }), key: 'wps_ab12cdef34567890' });
    render(<KeysTab project={project} />);
    await userEvent.click(screen.getByRole('button', { name: tk.create }));
    await userEvent.type(screen.getByLabelText(tk.name), 'billing');
    await userEvent.click(screen.getByRole('button', { name: tk.createSubmit }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith({ name: 'billing' }));
    expect(await screen.findByTestId('new-key')).toHaveProperty('textContent', 'wps_ab12cdef34567890');
    expect(screen.getByText(tk.shownOnceDescription)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: tk.copy }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wps_ab12cdef34567890');
    expect(await screen.findByText(tk.copied)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: tk.done }));
    await waitFor(() => expect(screen.queryByTestId('new-key')).toBeNull());
  });

  it('needs a name', async () => {
    render(<KeysTab project={project} />);
    await userEvent.click(screen.getByRole('button', { name: tk.create }));
    await userEvent.click(screen.getByRole('button', { name: tk.createSubmit }));
    expect(await screen.findByText(en.weldpanel.validation.nameRequired)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('tells the user when creating fails, without showing a key', async () => {
    state.create.mockRejectedValue(new ApiError('boom', 500));
    render(<KeysTab project={project} />);
    await userEvent.click(screen.getByRole('button', { name: tk.create }));
    await userEvent.type(screen.getByLabelText(tk.name), 'x');
    await userEvent.click(screen.getByRole('button', { name: tk.createSubmit }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith(tk.createFailed));
    expect(screen.queryByTestId('new-key')).toBeNull();
  });

  it('revokes after a confirmation', async () => {
    state.revoke.mockResolvedValue(undefined);
    render(<KeysTab project={project} />);
    await userEvent.click(screen.getByRole('button', { name: tk.revoke }));
    expect(state.revoke).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: tk.revokeConfirm }));
    await waitFor(() => expect(state.revoke).toHaveBeenCalledWith('wpkey_1'));
    expect(state.toast.success).toHaveBeenCalledWith(tk.revoked_toast);
  });

  it('shows an empty state, a skeleton and a retry', async () => {
    state.keys = { ...state.keys, data: [] };
    const { unmount } = render(<KeysTab project={project} />);
    expect(screen.getByText(tk.empty)).toBeTruthy();
    unmount();
    state.keys = { data: undefined, isLoading: false, error: new ApiError('boom', 500), refetch: vi.fn() };
    render(<KeysTab project={project} />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(state.keys.refetch).toHaveBeenCalled();
  });
});
