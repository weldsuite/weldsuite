import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const m = vi.hoisted(() => ({
  canManage: true,
  settings: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  devices: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  devicesAll: undefined as boolean | undefined,
  updateMutate: vi.fn(),
  revokeMutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: locale }) };
});
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (key: string) => key === 'passwords:manage' && m.canManage }),
}));
vi.mock('@/hooks/queries/use-weldpass-devices-queries', () => ({
  useWeldPassSettings: () => m.settings,
  useUpdateWeldPassSettings: () => ({ mutate: m.updateMutate, isPending: false }),
  useWeldPassDevices: (all: boolean) => {
    m.devicesAll = all;
    return m.devices;
  },
  useRevokeWeldPassDevice: () => ({ mutateAsync: m.revokeMutateAsync }),
}));

import WeldPassSettingsPage from './page';

const ts = en.settings.weldpass;

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dev_1',
    userId: 'user_1',
    name: "Gert's iPhone",
    platform: 'ios',
    appVersion: '1.0.2',
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lastSyncAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    revokedAt: null,
    revokedBy: null,
    userName: 'Gert van den Berg',
    userEmail: 'gert@example.com',
    ...overrides,
  };
}

describe('WeldPass settings page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.canManage = true;
    m.devicesAll = undefined;
    m.settings = { data: { offlineCopies: true }, isLoading: false, isError: false, refetch: vi.fn() };
    m.devices = { data: [device()], isLoading: false, isError: false, refetch: vi.fn() };
    m.revokeMutateAsync.mockResolvedValue(undefined);
  });

  it('shows the offline copy switch, on, with its explanation', () => {
    render(<WeldPassSettingsPage />);
    const toggle = screen.getByRole('switch', { name: ts.offline.switchLabel });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription(ts.offline.switchDescription);
  });

  it('saves the switch for a manager', async () => {
    render(<WeldPassSettingsPage />);
    await userEvent.click(screen.getByRole('switch', { name: ts.offline.switchLabel }));
    expect(m.updateMutate).toHaveBeenCalledWith(false, expect.anything());
  });

  it('keeps the switch read-only for someone who cannot manage passwords', async () => {
    m.canManage = false;
    render(<WeldPassSettingsPage />);
    const toggle = screen.getByRole('switch', { name: ts.offline.switchLabel });
    expect(toggle).toBeDisabled();
    await userEvent.click(toggle);
    expect(m.updateMutate).not.toHaveBeenCalled();
  });

  it('lists every device with its owner for a manager', () => {
    render(<WeldPassSettingsPage />);
    expect(m.devicesAll).toBe(true);
    const table = screen.getByRole('table', { name: ts.devices.caption });
    expect(within(table).getByText("Gert's iPhone")).toBeInTheDocument();
    expect(within(table).getByText('Gert van den Berg')).toBeInTheDocument();
    expect(within(table).getByText(ts.devices.platforms.ios)).toBeInTheDocument();
    expect(within(table).getByText('1.0.2')).toBeInTheDocument();
    expect(within(table).getByText(ts.devices.statusActive)).toBeInTheDocument();
  });

  it('lists only the own devices, without an owner column, for everyone else', () => {
    m.canManage = false;
    render(<WeldPassSettingsPage />);
    expect(m.devicesAll).toBe(false);
    expect(screen.queryByRole('columnheader', { name: ts.devices.owner })).toBeNull();
  });

  it('offers Revoke on an active device only', () => {
    m.devices.data = [
      device(),
      device({ id: 'dev_2', name: 'Old Pixel', platform: 'android', revokedAt: new Date().toISOString() }),
    ];
    render(<WeldPassSettingsPage />);
    expect(screen.getAllByRole('button', { name: /^Revoke / })).toHaveLength(1);
    expect(screen.getByText(ts.devices.statusRevoked)).toBeInTheDocument();
  });

  it('asks before revoking, and revokes on confirm', async () => {
    render(<WeldPassSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: "Revoke Gert's iPhone" }));
    expect(m.revokeMutateAsync).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    expect(within(dialog).getByText(ts.devices.revokeDescription)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: ts.devices.revoke }));
    expect(m.revokeMutateAsync).toHaveBeenCalledWith('dev_1');
  });

  it('does not revoke when the dialog is cancelled', async () => {
    render(<WeldPassSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: "Revoke Gert's iPhone" }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(m.revokeMutateAsync).not.toHaveBeenCalled();
  });

  it('shows the empty state when no phone keeps a copy', () => {
    m.devices.data = [];
    render(<WeldPassSettingsPage />);
    expect(screen.getByText(ts.devices.empty)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an error for each part that fails to load', () => {
    m.settings = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    m.devices = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    render(<WeldPassSettingsPage />);
    expect(screen.getByText(ts.offline.loadFailed)).toBeInTheDocument();
    expect(screen.getByText(ts.devices.loadFailed)).toBeInTheDocument();
  });
});
