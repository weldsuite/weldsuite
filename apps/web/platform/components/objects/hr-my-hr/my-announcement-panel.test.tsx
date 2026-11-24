import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrSelfAnnouncement, HrSelfAnnouncements } from '@weldsuite/app-api-client/domains/weldhr';

const mocks = vi.hoisted(() => ({ refetch: vi.fn(), markAsRead: vi.fn() }));
let queryState: 'loaded' | 'loading' | 'failed' = 'loaded';
let announcements: HrSelfAnnouncements;

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-workspace-url', () => ({
  useWorkspaceUrl: () => (path: string) => `https://app.test${path}`,
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrAnnouncements: () => ({
    data: queryState === 'loaded' ? announcements : undefined,
    isLoading: queryState === 'loading',
    error: queryState === 'failed' ? new Error('Server unavailable') : null,
    refetch: mocks.refetch,
  }),
}));
vi.mock('@/app/weldhr/me/components/announcements-tab', () => ({
  useMarkMyAnnouncementRead: () => mocks.markAsRead,
}));

import { MyAnnouncementPanel } from './my-announcement-panel';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeAnnouncement(extra: Partial<HrSelfAnnouncement> = {}): HrSelfAnnouncement {
  return {
    id: 'ann_1',
    title: 'Office closed',
    body: 'Line one\nLine two <b>not bold</b>',
    pinned: false,
    publishedAt: '2026-05-01T09:00:00Z',
    updatedAt: '2026-05-01T09:30:00Z',
    createdByName: 'Hannah HR',
    readAt: null,
    ...extra,
  };
}

function renderPanel(id = 'ann_1') {
  return renderWithProviders(<MyAnnouncementPanel id={id} isOpen onClose={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryState = 'loaded';
  announcements = { announcements: [makeAnnouncement()], unread: 1 };
});

describe('MyAnnouncementPanel', () => {
  it('shows the whole text as plain text and marks the announcement as read', () => {
    renderPanel();
    expect(screen.getByText('Office closed')).toBeInTheDocument();
    expect(screen.getByText('Hannah HR')).toBeInTheDocument();
    expect(screen.getByText(/Line two <b>not bold<\/b>/)).toBeInTheDocument();
    expect(mocks.markAsRead).toHaveBeenCalledWith(expect.objectContaining({ id: 'ann_1' }));
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
  });

  it('shows a pinned announcement that was read and edited later', () => {
    announcements = {
      announcements: [
        makeAnnouncement({
          pinned: true,
          readAt: '2026-05-02T10:00:00Z',
          updatedAt: '2026-05-03T10:00:00Z',
        }),
      ],
      unread: 0,
    };
    renderPanel();
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getAllByText(/May/).length).toBeGreaterThanOrEqual(3);
  });

  it('has a copy-link menu for the announcement', async () => {
    renderPanel();
    await userEvent.setup().click(screen.getByRole('button', { name: /more actions/i }));
    expect(await screen.findByRole('menuitem', { name: /copy link/i })).toBeInTheDocument();
  });

  it('marks nothing as read when the announcement is gone', () => {
    renderPanel('ann_unknown');
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
    expect(mocks.markAsRead).not.toHaveBeenCalled();
  });

  it('shows the error with Try again when the list failed', async () => {
    queryState = 'failed';
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('shows nothing of the announcement while loading', () => {
    queryState = 'loading';
    renderPanel();
    expect(screen.queryByText('Office closed')).not.toBeInTheDocument();
    expect(mocks.markAsRead).not.toHaveBeenCalled();
  });
});
