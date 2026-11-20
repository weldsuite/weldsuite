import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';

interface SettingsState {
  data: { replenishmentEnabled: boolean } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const env = vi.hoisted(() => ({
  search: {} as { tab?: string; plan?: string },
  navigate: vi.fn(),
  push: vi.fn(),
  settings: undefined as unknown,
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => env.navigate,
  useSearch: () => env.search,
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/components/edition-unavailable-page', () => ({
  EditionUnavailablePage: () => <div>Not available in this edition</div>,
}));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  useReplenishmentSettings: () => env.settings,
}));
vi.mock('./components/all-items-tab', () => ({
  AllItemsTab: ({ onOpenPlan }: { onOpenPlan: (id: string) => void }) => (
    <button onClick={() => onOpenPlan('plan_items')}>items tab</button>
  ),
}));
vi.mock('./components/reorder-tab', () => ({
  ReorderTab: ({ onOpenPlan, onOpenSettings }: { onOpenPlan: (id: string) => void; onOpenSettings: () => void }) => (
    <div>
      <button onClick={() => onOpenPlan('plan_reorder')}>reorder tab</button>
      <button onClick={onOpenSettings}>settings from reorder</button>
    </div>
  ),
}));
vi.mock('./components/enable-screen', () => ({
  EnableScreen: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <button onClick={onOpenSettings}>enable screen</button>
  ),
}));
vi.mock('./components/plan-panel', () => ({
  PlanPanel: ({ planId, onClose }: { planId: string | null; onClose: () => void }) => (
    <div>
      <span data-testid="open-plan">{planId ?? 'none'}</span>
      <button onClick={onClose}>close panel</button>
    </div>
  ),
}));
vi.mock('./components/run-status', () => ({ RunStatus: () => <div>run status</div> }));

import WeldStashReplenishmentPage from './page';

function settings(overrides: Partial<SettingsState> = {}): SettingsState {
  return { data: { replenishmentEnabled: true }, isLoading: false, isError: false, error: null, refetch: env.refetch, ...overrides };
}

beforeEach(() => {
  setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash'], unavailableFeatures: [] } as never);
  env.search = {};
  env.settings = settings();
  env.navigate.mockReset();
  env.push.mockReset();
  env.refetch.mockReset();
  window.history.pushState({}, '', '/w/acme/weldstash/replenishment');
});

afterEach(() => {
  setRuntimeConfig(null);
  sessionStorage.clear();
});

describe('WeldStashReplenishmentPage', () => {
  it('is the edition-unavailable page on Global', () => {
    setRuntimeConfig(null);
    render(<WeldStashReplenishmentPage />);
    expect(screen.getByText('Not available in this edition')).toBeInTheDocument();
    expect(screen.queryByText('reorder tab')).not.toBeInTheDocument();
  });

  it('shows the Reorder tab and the run status by default', async () => {
    render(<WeldStashReplenishmentPage />);
    expect(await screen.findByRole('heading', { name: 'Replenishment' })).toBeInTheDocument();
    expect(screen.getByText('run status')).toBeInTheDocument();
    expect(screen.getByText('reorder tab')).toBeInTheDocument();
    expect(screen.queryByText('items tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-plan')).toHaveTextContent('none');
  });

  it('shows the tab named in the URL, and Reorder for an unknown tab', async () => {
    env.search = { tab: 'items' };
    const { unmount } = render(<WeldStashReplenishmentPage />);
    expect(await screen.findByText('items tab')).toBeInTheDocument();
    unmount();

    env.search = { tab: 'nonsense' };
    render(<WeldStashReplenishmentPage />);
    expect(await screen.findByText('reorder tab')).toBeInTheDocument();
  });

  it('puts the tab in the URL search, replacing the history entry and keeping the rest', async () => {
    const user = userEvent.setup();
    render(<WeldStashReplenishmentPage />);
    await user.click(await screen.findByRole('tab', { name: 'All items' }));
    expect(env.navigate).toHaveBeenCalledTimes(1);
    const call = env.navigate.mock.calls[0][0] as { to: string; replace: boolean; search: (prev: Record<string, unknown>) => unknown };
    expect(call.to).toBe('.');
    expect(call.replace).toBe(true);
    expect(call.search({ plan: 'plan_9' })).toEqual({ plan: 'plan_9', tab: 'items' });
  });

  it('opens a plan from either tab by putting it in the URL, and closes it again', async () => {
    const user = userEvent.setup();
    env.search = { plan: 'plan_7' };
    render(<WeldStashReplenishmentPage />);
    expect(await screen.findByTestId('open-plan')).toHaveTextContent('plan_7');

    await user.click(screen.getByText('reorder tab'));
    const open = env.navigate.mock.calls[0][0] as { search: (prev: Record<string, unknown>) => unknown };
    expect(open.search({ tab: 'reorder' })).toEqual({ tab: 'reorder', plan: 'plan_reorder' });

    await user.click(screen.getByText('close panel'));
    const close = env.navigate.mock.calls[1][0] as { search: (prev: Record<string, unknown>) => unknown };
    expect(close.search({ tab: 'reorder', plan: 'plan_7' })).toEqual({ tab: 'reorder', plan: undefined });
  });

  it('opens a plan from the All items tab', async () => {
    const user = userEvent.setup();
    env.search = { tab: 'items' };
    render(<WeldStashReplenishmentPage />);
    await user.click(await screen.findByText('items tab'));
    const open = env.navigate.mock.calls[0][0] as { search: (prev: Record<string, unknown>) => unknown };
    expect(open.search({})).toEqual({ plan: 'plan_items' });
  });

  it('opens the WeldStash settings and remembers where to come back to', async () => {
    const user = userEvent.setup();
    render(<WeldStashReplenishmentPage />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(env.push).toHaveBeenCalledWith('/settings/apps/weldstash');
    expect(sessionStorage.getItem('settings-return-url')).toBe('/weldstash/replenishment');

    await user.click(screen.getByText('settings from reorder'));
    expect(env.push).toHaveBeenCalledTimes(2);
  });

  it('shows the enable screen while replenishment is off', async () => {
    const user = userEvent.setup();
    env.settings = settings({ data: { replenishmentEnabled: false } });
    render(<WeldStashReplenishmentPage />);
    await user.click(await screen.findByText('enable screen'));
    expect(env.push).toHaveBeenCalledWith('/settings/apps/weldstash');
    expect(screen.queryByText('reorder tab')).not.toBeInTheDocument();
  });

  it('shows a loader while the settings load', () => {
    env.settings = settings({ data: undefined, isLoading: true });
    render(<WeldStashReplenishmentPage />);
    expect(screen.queryByText('enable screen')).not.toBeInTheDocument();
    expect(screen.queryByText('reorder tab')).not.toBeInTheDocument();
  });

  it('shows the error with a retry when the settings fail', async () => {
    const user = userEvent.setup();
    env.settings = settings({ data: undefined, isError: true, error: new Error('Settings down') });
    render(<WeldStashReplenishmentPage />);
    expect(await screen.findByText('Settings down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('shows a generic message when the settings fail without one', async () => {
    env.settings = settings({ data: undefined, isError: true, error: null });
    render(<WeldStashReplenishmentPage />);
    expect(await screen.findByText('Could not load replenishment.')).toBeInTheDocument();
  });
});
