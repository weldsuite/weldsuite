import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { NotificationsSection } from './notifications-section';

const state = vi.hoisted(() => ({
  can: true,
  subscriptions: { isLoading: false, isError: false, data: [] as unknown[], refetch: vi.fn() },
  channels: { data: { data: [{ id: 'ch_1', name: 'engineering', type: 'public' }, { id: 'ch_2', name: 'old', type: 'public', isArchived: true }] } },
  teams: { data: [{ id: 'mtm_1', name: 'Platform', key: 'PLAT' }] },
  repositories: { data: [{ id: 'mrp_1', fullName: 'acme/api' }] },
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.can }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({ useChannels: () => state.channels }));
vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({
  useMergeTeams: () => state.teams,
  useMergeRepositories: () => state.repositories,
}));
vi.mock('@/hooks/queries/use-weldmerge-across-queries', () => ({
  useMergeChatSubscriptions: () => state.subscriptions,
  useCreateMergeChatSubscription: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateMergeChatSubscription: () => ({ mutateAsync: state.update, isPending: false }),
  useRemoveMergeChatSubscription: () => ({ mutateAsync: state.remove, isPending: false }),
}));

const subscription = {
  id: 'mcs_1',
  channelId: 'ch_1',
  teamId: 'mtm_1',
  repositoryId: null,
  events: ['review_requested', 'daily_digest'],
  digestHour: 8,
  createdByUserId: 'user_1',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

beforeEach(() => {
  state.can = true;
  state.subscriptions = { isLoading: false, isError: false, data: [], refetch: vi.fn() };
  state.create = vi.fn().mockResolvedValue({});
  state.update = vi.fn().mockResolvedValue({});
  state.remove = vi.fn().mockResolvedValue(undefined);
});

describe('NotificationsSection', () => {
  it('needs merge_teams:manage', () => {
    state.can = false;
    render(<NotificationsSection />);
    expect(screen.getByText(en.weldmerge.across.notifications.readOnly)).toBeTruthy();
  });

  it('shows an empty state and the error state', () => {
    const { unmount } = render(<NotificationsSection />);
    expect(screen.getByText(en.weldmerge.across.notifications.empty)).toBeTruthy();
    unmount();
    state.subscriptions = { isLoading: false, isError: true, data: [], refetch: vi.fn() };
    render(<NotificationsSection />);
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.retry }));
    expect(state.subscriptions.refetch).toHaveBeenCalled();
  });

  it('lists a subscription with its channel, filter, events and digest hour', () => {
    state.subscriptions.data = [subscription];
    render(<NotificationsSection />);
    expect(screen.getByText('engineering')).toBeTruthy();
    expect(screen.getByText(/Platform/)).toBeTruthy();
    expect(screen.getByText(en.weldmerge.across.notifications.event.review_requested)).toBeTruthy();
    expect(screen.getByText(/Daily digest · 08:00 UTC/)).toBeTruthy();
  });

  it('asks for a channel before adding a subscription', async () => {
    render(<NotificationsSection />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.weldmerge.across.notifications.add) }));
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.notifications.create }));
    expect(await screen.findByText(en.weldmerge.across.notifications.needChannel)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('refuses a subscription with no event', async () => {
    state.subscriptions.data = [subscription];
    render(<NotificationsSection />);
    fireEvent.click(screen.getByRole('button', { name: en.common.actions.edit }));
    fireEvent.click(screen.getByRole('checkbox', { name: en.weldmerge.across.notifications.event.review_requested }));
    fireEvent.click(screen.getByRole('checkbox', { name: en.weldmerge.across.notifications.event.daily_digest }));
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.notifications.save }));
    expect(await screen.findByText(en.weldmerge.across.notifications.needEvent)).toBeTruthy();
    expect(state.update).not.toHaveBeenCalled();
  });

  it('saves changed events', async () => {
    state.subscriptions.data = [subscription];
    render(<NotificationsSection />);
    fireEvent.click(screen.getByRole('button', { name: en.common.actions.edit }));
    fireEvent.click(screen.getByRole('checkbox', { name: en.weldmerge.across.notifications.event.checks_failed }));
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.notifications.save }));
    await waitFor(() => expect(state.update).toHaveBeenCalled());
    expect(state.update).toHaveBeenCalledWith({
      id: 'mcs_1',
      input: {
        teamId: 'mtm_1',
        repositoryId: null,
        events: ['review_requested', 'daily_digest', 'checks_failed'],
        digestHour: 8,
      },
    });
  });

  it('confirms before removing', async () => {
    state.subscriptions.data = [subscription];
    render(<NotificationsSection />);
    fireEvent.click(screen.getByRole('button', { name: en.weldmerge.across.notifications.remove }));
    expect(screen.getByText('Stop posting to engineering?')).toBeTruthy();
    expect(state.remove).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: en.weldmerge.across.notifications.remove });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('mcs_1'));
  });
});
