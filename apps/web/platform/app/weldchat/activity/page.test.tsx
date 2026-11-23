import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { ActivityItem } from '@weldsuite/core-api-client/schemas/weldchat-activity';

interface DmFixture {
  id: string;
  name: string | null;
  otherMembers?: Array<{ name: string | null }>;
}

const mocks = vi.hoisted(() => ({
  items: [] as ActivityItem[],
  dms: [] as DmFixture[],
  markRead: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => {} }));
vi.mock('@/components/member-avatar', () => ({ MemberAvatar: () => <span data-testid="avatar" /> }));
vi.mock('../components/entity-mention-chip', () => ({ EntityMentionChip: () => null }));
vi.mock('@/hooks/queries/use-weldchat-extras-queries', () => ({
  useChatActivity: () => ({
    data: { pages: [{ data: mocks.items }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useMarkActivityRead: () => ({ mutate: mocks.markRead }),
}));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: [{ userId: 'user_ann', name: 'Ann Archer', picture: null }] } }),
  useDmChannels: () => ({ data: { data: mocks.dms } }),
}));
// The list itself has tests of its own; here it only lays out the rows.
vi.mock('@/components/entity-list', () => ({
  EmptyStateIllustration: ({ children }: { children: ReactNode }) => <>{children}</>,
  EntityList: ({ items, renderRow }: { items: ActivityItem[]; renderRow: (item: ActivityItem) => ReactNode }) => (
    <div>{items.map((item) => renderRow(item))}</div>
  ),
}));

import ActivityPage from './page';

const inChannel = en.sweep.weldchat.bookmarksPanel.inChannel;

function item(id: string, extra: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    type: 'chat_mention',
    title: `Title ${id}`,
    body: null,
    channelId: null,
    channelName: null,
    messageId: null,
    actorId: 'user_ann',
    actorName: null,
    actorAvatarUrl: null,
    actionUrl: null,
    readAt: '2026-11-20T10:00:00Z',
    createdAt: '2026-11-20T10:00:00Z',
    ...extra,
  };
}

function renderPage() {
  render(
    <I18nProvider initialLanguage="en">
      <ActivityPage />
    </I18nProvider>,
  );
}

/** The row of an item, the button its title sits in. */
const row = (id: string) => screen.getByText(`Title ${id}`).closest('button') as HTMLElement;

beforeEach(() => {
  mocks.items = [];
  mocks.dms = [];
});

afterEach(cleanup);

describe('ActivityPage rows', () => {
  it('names a DM after who it is with, without the "in #channel" suffix', () => {
    mocks.dms = [{ id: 'ch_dm1', name: 'dm-ann-bob', otherMembers: [{ name: 'Ann Archer' }, { name: null }, { name: 'Bob Baker' }] }];
    mocks.items = [item('a1', { channelId: 'ch_dm1', channelName: 'dm-ann-bob' })];
    renderPage();

    expect(row('a1').textContent).toContain('Ann Archer, Bob Baker');
    expect(row('a1').textContent).not.toContain(inChannel);
    expect(row('a1').textContent).not.toContain('#dm-ann-bob');
  });

  it('keeps the own name of a DM with yourself', () => {
    mocks.dms = [{ id: 'ch_self', name: 'Notes to self', otherMembers: [] }];
    mocks.items = [item('a2', { channelId: 'ch_self' })];
    renderPage();

    expect(row('a2').textContent).toContain('Notes to self');
  });

  it('finds the DM from the link when the row has no channel id', () => {
    mocks.dms = [{ id: 'ch_dm2', name: null, otherMembers: [{ name: 'Cleo Chen' }] }];
    mocks.items = [item('a3', { actionUrl: '/weldchat/dm/ch_dm2?message=msg_1' })];
    renderPage();

    expect(row('a3').textContent).toContain('Cleo Chen');
  });

  it('shows a channel as #name, with the "in #channel" suffix', () => {
    mocks.dms = [{ id: 'ch_nameless', name: null }];
    mocks.items = [item('a4', { channelId: 'ch_general', channelName: 'general' })];
    renderPage();

    expect(row('a4').textContent).toContain(`${inChannel} #general`);
    expect(row('a4').textContent).toContain('#general');
  });

  it('shows a dash for a row without a conversation', () => {
    mocks.items = [item('a5')];
    renderPage();

    expect(row('a5').textContent).toContain('—');
  });

  it("shows a mention's text under the title, nudging the avatar up to the title line", () => {
    mocks.items = [item('a6', { body: 'Can you check the invoice?', channelName: 'sales' })];
    renderPage();

    expect(screen.getByText('Can you check the invoice?')).toBeTruthy();
    const avatarBox = row('a6').querySelector('[data-testid="avatar"]')?.parentElement;
    expect(avatarBox?.className).toContain('-top-[6px]');
  });

  it('leaves out the "Tap to call back" text of a missed call', () => {
    mocks.items = [item('a7', { type: 'chat_missed_call', body: 'Tap to call back', channelId: 'ch_dm1' })];
    mocks.dms = [{ id: 'ch_dm1', name: null, otherMembers: [{ name: 'Ann Archer' }] }];
    renderPage();

    expect(screen.queryByText('Tap to call back')).toBeNull();
    const avatarBox = row('a7').querySelector('[data-testid="avatar"]')?.parentElement;
    expect(avatarBox?.className).not.toContain('-top-[6px]');
  });
});
