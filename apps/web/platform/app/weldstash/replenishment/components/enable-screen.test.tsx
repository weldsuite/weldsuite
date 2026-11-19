import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  permissions: new Set<string>(),
  update: vi.fn(),
  startRun: vi.fn(),
  updatePending: false,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  useUpdateReplenishmentSettings: () => ({ mutateAsync: env.update, isPending: env.updatePending }),
  useStartPlanningRun: () => ({ mutateAsync: env.startRun, isPending: false }),
}));

import { EnableScreen } from './enable-screen';

beforeEach(() => {
  env.permissions = new Set(['inventory:manage']);
  env.updatePending = false;
  env.update.mockReset().mockResolvedValue({});
  env.startRun.mockReset().mockResolvedValue({});
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

describe('EnableScreen', () => {
  it('explains what replenishment does in three steps', () => {
    render(<EnableScreen onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Know what to buy, and when' })).toBeInTheDocument();
    expect(screen.getByText('A forecast per item')).toBeInTheDocument();
    expect(screen.getByText('A reorder list')).toBeInTheDocument();
    expect(screen.getByText('Draft purchase orders')).toBeInTheDocument();
  });

  it('turns replenishment on and starts the first calculation', async () => {
    const user = userEvent.setup();
    render(<EnableScreen onOpenSettings={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Turn on replenishment' }));
    expect(env.update).toHaveBeenCalledWith({ replenishmentEnabled: true });
    expect(env.toast.success).toHaveBeenCalledWith('Replenishment is on');
    expect(env.startRun).toHaveBeenCalledTimes(1);
  });

  it('still counts as enabled when the first calculation cannot start', async () => {
    env.startRun.mockRejectedValue(new Error('busy'));
    const user = userEvent.setup();
    render(<EnableScreen onOpenSettings={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Turn on replenishment' }));
    expect(env.toast.success).toHaveBeenCalledWith('Replenishment is on');
    expect(env.toast.error).not.toHaveBeenCalled();
  });

  it('shows the server message when turning it on fails, and a fallback without one', async () => {
    const user = userEvent.setup();
    env.update.mockRejectedValueOnce(new Error('Not allowed'));
    render(<EnableScreen onOpenSettings={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Turn on replenishment' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Not allowed');
    expect(env.startRun).not.toHaveBeenCalled();

    env.update.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Turn on replenishment' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Could not turn on replenishment');
  });

  it('opens the settings from the screen', async () => {
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<EnableScreen onOpenSettings={onOpenSettings} />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('shows the busy label while turning on', () => {
    env.updatePending = true;
    render(<EnableScreen onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Turning on…' })).toBeDisabled();
  });

  it('tells people who cannot manage inventory who to ask, without a switch', () => {
    env.permissions = new Set();
    render(<EnableScreen onOpenSettings={vi.fn()} />);
    expect(screen.getByText(/Ask someone who can manage inventory/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on replenishment' })).not.toBeInTheDocument();
  });
});
