import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

const mocks = vi.hoisted(() => ({
  members: [] as Array<{ userId: string; name?: string | null; email?: string | null; picture?: string }>,
  openUserProfile: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en }) }));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n/date-locale', () => ({ useDateLocale: () => ({ intlLocale: 'en-US' }) }));
vi.mock('./chat-context', () => ({ useChatContext: () => ({ openUserProfile: mocks.openUserProfile }) }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: mocks.members } }),
}));
vi.mock('@/components/member-avatar', () => ({
  MemberAvatar: ({ userId, fallback }: { userId?: string; fallback: string }) => (
    <span data-testid="avatar" data-user-id={userId}>
      {fallback}
    </span>
  ),
}));

import { ChannelEmptyState } from './channel-empty-state';

type Channel = NonNullable<ComponentProps<typeof ChannelEmptyState>['channel']>;
const ces = en.weldchat.channelEmptyState;

function channel(extra: Record<string, unknown>): Channel {
  return { id: 'ch_1', name: 'general', type: 'public', createdBy: null, createdAt: null, ...extra } as unknown as Channel;
}

/** The sentence under the title, with its spacing collapsed. */
const intro = () => (screen.getByRole('heading').parentElement?.nextElementSibling?.textContent ?? '').replace(/\s+/g, ' ');

beforeEach(() => {
  mocks.members = [{ userId: 'user_ann', name: 'Ann Archer' }];
  mocks.openUserProfile.mockReset();
});

afterEach(cleanup);

describe('ChannelEmptyState, a channel', () => {
  it('says who created it and when, with its topic, and opens their profile', () => {
    render(
      <ChannelEmptyState
        channel={channel({ createdBy: 'user_ann', createdAt: '2026-11-21T12:00:00Z', topic: 'Company news' })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'general' })).toBeTruthy();
    expect(intro()).toBe(
      `Ann Archer ${ces.channelCreated} ${ces.channelCreatedOn} November 21, 2026. ${ces.veryBeginning} #general ${ces.channel}`,
    );
    expect(screen.getByText('Company news')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ann Archer' }));
    expect(mocks.openUserProfile).toHaveBeenCalledWith('user_ann');
  });

  it("leaves out an author it doesn't know and a date it can't read", () => {
    render(<ChannelEmptyState channel={channel({ type: 'private', name: 'board', createdBy: 'user_gone', createdAt: 'soon' })} />);

    expect(intro()).toBe(`${ces.channelCreatedNoAuthor}. ${ces.veryBeginning} 🔒board ${ces.channel}`);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it("names the author by email, and not at all when the member has neither name nor email", () => {
    mocks.members = [
      { userId: 'user_ann', name: null, email: 'ann@example.com' },
      { userId: 'user_x', name: null, email: null },
    ];
    const { rerender } = render(<ChannelEmptyState channel={channel({ createdBy: 'user_ann' })} />);
    expect(screen.getByRole('button', { name: 'ann@example.com' })).toBeTruthy();

    rerender(<ChannelEmptyState channel={channel({ createdBy: 'user_x' })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ChannelEmptyState, a DM', () => {
  it('names a DM after who it is with, with their avatar', () => {
    render(
      <ChannelEmptyState
        channel={channel({
          type: 'dm',
          name: 'dm-x',
          createdBy: 'user_ann',
          createdAt: '2026-11-21T12:00:00Z',
          otherMembers: [{ userId: 'user_bob', name: 'Bob Baker' }],
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Bob Baker' })).toBeTruthy();
    expect(screen.getByTestId('avatar').dataset.userId).toBe('user_bob');
    expect(screen.getByTestId('avatar').textContent).toBe('B');
    expect(intro()).toBe(`Ann Archer ${ces.dmStarted} ${ces.channelCreatedOn} November 21, 2026.`);
  });

  it("shows your own avatar and the DM's name in a DM with yourself", () => {
    mocks.members = [];
    render(<ChannelEmptyState channel={channel({ type: 'dm', name: 'Notes', createdBy: 'user_me' })} />);

    expect(screen.getByRole('heading', { name: 'Notes' })).toBeTruthy();
    expect(screen.getByTestId('avatar').dataset.userId).toBe('user_me');
    expect(intro()).toBe(`${ces.dmStartedNoAuthor}.`);
  });

  it('falls back to the email, then to a generic name', () => {
    const { rerender } = render(
      <ChannelEmptyState channel={channel({ type: 'dm', name: null, otherMembers: [{ userId: 'u', email: 'bob@example.com' }] })} />,
    );
    expect(screen.getByRole('heading', { name: 'bob@example.com' })).toBeTruthy();

    rerender(<ChannelEmptyState channel={channel({ type: 'dm', name: null, otherMembers: [] })} />);
    expect(screen.getByRole('heading', { name: 'sweep.weldchat.channelEmptyState.directMessageFallback' })).toBeTruthy();
  });
});

describe('ChannelEmptyState, a group', () => {
  it('names a group after its members, with a group tile', () => {
    render(
      <ChannelEmptyState
        channel={channel({
          type: 'dm',
          otherMembers: [
            { userId: 'u1', name: 'Bob Baker' },
            { userId: 'u2', email: 'cleo@example.com' },
            { userId: 'u3' },
          ],
        })}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Bob Baker, cleo@example.com, sweep.weldchat.channelEmptyState.memberFallback' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('avatar')).toBeNull();
    expect(intro()).toBe(ces.groupConversationBeginning);
  });

  it("uses the group's name, then a generic one, while its members aren't known", () => {
    const { rerender } = render(<ChannelEmptyState channel={channel({ type: 'group', name: 'Launch crew' })} />);
    expect(screen.getByRole('heading', { name: 'Launch crew' })).toBeTruthy();

    rerender(<ChannelEmptyState channel={channel({ type: 'group', name: null })} />);
    expect(screen.getByRole('heading', { name: 'sweep.weldchat.channelEmptyState.groupFallback' })).toBeTruthy();
  });
});
