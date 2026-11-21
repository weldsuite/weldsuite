import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

interface RunState {
  latest: { status: 'done' | 'failed' | 'running'; finishedAt: string | null; error: string | null } | null;
  running: boolean;
}

const env = vi.hoisted(() => ({
  state: { latest: null, running: false } as RunState,
  permissions: new Set<string>(),
  start: vi.fn(),
  pending: false,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  usePlanningRunStatus: () => env.state,
  useStartPlanningRun: () => ({ mutateAsync: env.start, isPending: env.pending }),
}));

import { RunStatus } from './run-status';

beforeEach(() => {
  env.state = { latest: null, running: false };
  env.permissions = new Set(['inventory:manage']);
  env.pending = false;
  env.start.mockReset().mockResolvedValue({});
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

describe('RunStatus', () => {
  it('says nothing was calculated yet', () => {
    render(<RunStatus />);
    expect(screen.getByRole('status')).toHaveTextContent('Not calculated yet');
    expect(screen.getByRole('button', { name: 'Recalculate now' })).toBeEnabled();
  });

  it('shows when the last finished run was', () => {
    env.state = { latest: { status: 'done', finishedAt: '2026-11-18T02:00:00Z', error: null }, running: false };
    render(<RunStatus />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Last calculated .*2026/);
  });

  it('shows no time for a finish moment it cannot read', () => {
    env.state = { latest: { status: 'done', finishedAt: 'garbage', error: null }, running: false };
    render(<RunStatus />);
    expect(screen.getByRole('status').textContent?.trim()).toBe('Last calculated');
  });

  it('shows the error of a failed run in the destructive colour', () => {
    env.state = { latest: { status: 'failed', finishedAt: null, error: 'engine crashed' }, running: false };
    render(<RunStatus />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('The last calculation failed: engine crashed');
    expect(status).toHaveClass('text-destructive');
  });

  it('shows a failed run without an error text', () => {
    env.state = { latest: { status: 'failed', finishedAt: null, error: null }, running: false };
    render(<RunStatus />);
    expect(screen.getByRole('status')).toHaveTextContent('The last calculation failed:');
  });

  it('disables the button while a run is going', () => {
    env.state = { latest: { status: 'running', finishedAt: null, error: null }, running: true };
    render(<RunStatus />);
    expect(screen.getByRole('status')).toHaveTextContent('Calculating…');
    expect(screen.getByRole('button', { name: 'Calculating…' })).toBeDisabled();
  });

  it('starts a run and confirms it', async () => {
    const user = userEvent.setup();
    render(<RunStatus />);
    await user.click(screen.getByRole('button', { name: 'Recalculate now' }));
    expect(env.start).toHaveBeenCalledTimes(1);
    expect(env.toast.success).toHaveBeenCalledWith('Calculation started');
  });

  it('shows the server message when the run cannot start, and a fallback without one', async () => {
    const user = userEvent.setup();
    env.start.mockRejectedValueOnce(new Error('A run is already going'));
    render(<RunStatus />);
    await user.click(screen.getByRole('button', { name: 'Recalculate now' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('A run is already going');

    env.start.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Recalculate now' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Could not start the calculation');
  });

  it('hides the button from people who cannot manage inventory', () => {
    env.permissions = new Set();
    render(<RunStatus />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
