import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import type { RecordChatListItem } from '@/hooks/queries/use-weldchat-queries';

const state = vi.hoisted(() => ({
  search: {} as { type?: string; filter?: string },
  summary: undefined as RecordChatTypeSummary[] | undefined,
  rows: [] as unknown[],
  hidden: new Set<string>(),
  listCalls: [] as Array<{ type: string | undefined; filter: string | undefined; search: string | undefined }>,
  navigate: vi.fn(),
  setGroupHidden: vi.fn(),
  follow: vi.fn(),
  unfollow: vi.fn(),
  mute: vi.fn(),
  openPanel: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: state.openPanel }) }));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useRecordChatSummary: () => ({ data: state.summary ? { data: state.summary } : undefined }),
  useRecordChats: (type: string | undefined, opts: { filter?: string; search?: string }) => {
    state.listCalls.push({ type, filter: opts.filter, search: opts.search });
    return {
      data: { pages: [{ data: state.rows }] },
      isLoading: false,
      error: null,
      isPlaceholderData: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
  },
  useWorkspaceMembers: () => ({ data: { data: [] } }),
  useFollowRecordChat: () => ({ mutate: state.follow }),
  useUnfollowRecordChat: () => ({ mutate: state.unfollow }),
  useMuteChannel: () => ({ mutate: state.mute }),
}));
vi.mock('../hooks/use-group-hidden', () => ({
  useGroupHidden: () => ({
    isGroupHidden: (key: string) => state.hidden.has(key),
    setGroupHidden: state.setGroupHidden,
  }),
}));

import RecordChatsPage from './page';

const K = 'sweep.weldchat.recordChats';

const summaryRow = (type: string): RecordChatTypeSummary => ({ type, label: type, followed: 1, unread: 0, mentions: 0 });

function chat(overrides: Partial<RecordChatListItem> = {}): RecordChatListItem {
  return {
    id: 'ch_1',
    type: 'entity',
    name: 'company-cmp_1',
    entityType: 'company',
    entityId: 'cmp_1',
    entityDisplayName: 'Acme',
    lastMessageAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastMessagePreview: 'Invoice sent',
    isFollowing: true,
    isMuted: false,
    lastReadAt: new Date().toISOString(),
    lastReadMessageId: null,
    unreadMentionCount: 0,
    ...overrides,
  };
}

const lastListCall = () => state.listCalls.at(-1);
const tab = (name: string) => screen.getByRole('tab', { name });

beforeEach(() => {
  state.search = {};
  state.summary = ['company', 'person', 'task', 'project', 'domain'].map(summaryRow);
  state.rows = [];
  state.hidden = new Set();
  state.listCalls = [];
  for (const fn of [state.navigate, state.setGroupHidden, state.follow, state.unfollow, state.mute, state.openPanel]) {
    fn.mockReset();
  }
});

describe('RecordChatsPage tabs', () => {
  it('has an All tab and one tab per record type, in group order', () => {
    render(<RecordChatsPage />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      `${K}.page.allTab`,
      `${K}.groups.company`,
      `${K}.groups.person`,
      `${K}.groups.task`,
      `${K}.groups.project`,
      `${K}.groups.domain`,
    ]);
    expect(tab(`${K}.page.allTab`).getAttribute('aria-selected')).toBe('true');
    expect(lastListCall()).toEqual({ type: undefined, filter: 'following', search: '' });
  });

  it('hides the tabs of types the caller has no permission for', () => {
    state.summary = [summaryRow('task'), summaryRow('project')];
    render(<RecordChatsPage />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      `${K}.page.allTab`,
      `${K}.groups.task`,
      `${K}.groups.project`,
    ]);
  });

  it('opens the tab the URL names (a sidebar "Show all" link)', () => {
    state.search = { type: 'task' };
    render(<RecordChatsPage />);
    expect(tab(`${K}.groups.task`).getAttribute('aria-selected')).toBe('true');
    expect(lastListCall()?.type).toBe('task');
  });

  it('falls back to All for a type the caller may not list', () => {
    state.search = { type: 'company' };
    state.summary = [summaryRow('task')];
    render(<RecordChatsPage />);
    expect(screen.queryByRole('tab', { name: `${K}.groups.company` })).toBeNull();
    expect(tab(`${K}.page.allTab`).getAttribute('aria-selected')).toBe('true');
    expect(lastListCall()?.type).toBeUndefined();
  });

  it('keeps the asked-for tab while the summary loads', () => {
    state.search = { type: 'domain' };
    state.summary = undefined;
    render(<RecordChatsPage />);
    expect(tab(`${K}.groups.domain`).getAttribute('aria-selected')).toBe('true');
    expect(lastListCall()?.type).toBe('domain');
  });

  it('writes the chosen tab into the URL and keeps the filter', () => {
    state.search = { filter: 'unread' };
    render(<RecordChatsPage />);
    fireEvent.click(tab(`${K}.groups.person`));
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/records', search: { type: 'person', filter: 'unread' } });
  });

  it('leaves the type out of the URL on the All tab', () => {
    state.search = { type: 'person' };
    render(<RecordChatsPage />);
    fireEvent.click(tab(`${K}.page.allTab`));
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/records', search: {} });
  });
});

describe('RecordChatsPage filters', () => {
  const radio = (filter: string) => screen.getByRole('radio', { name: `${K}.page.filters.${filter}` });

  it('lists followed chats by default', () => {
    render(<RecordChatsPage />);
    expect(radio('following').getAttribute('aria-checked')).toBe('true');
    expect(lastListCall()?.filter).toBe('following');
  });

  it.each(['unread', 'mentions', 'all'])('lists the "%s" filter the URL names', (filter) => {
    state.search = { filter };
    render(<RecordChatsPage />);
    expect(radio(filter).getAttribute('aria-checked')).toBe('true');
    expect(lastListCall()?.filter).toBe(filter);
  });

  it('writes the chosen filter into the URL, the default one left out', () => {
    state.search = { type: 'company', filter: 'mentions' };
    render(<RecordChatsPage />);
    fireEvent.click(radio('all'));
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: { type: 'company', filter: 'all' } });
    fireEvent.click(radio('following'));
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: { type: 'company' } });
  });

  it.each(['following', 'unread', 'mentions', 'all'])('has its own empty state under "%s"', (filter) => {
    state.search = { filter };
    render(<RecordChatsPage />);
    expect(screen.getByText(`${K}.page.empty.${filter}.title`)).toBeTruthy();
    expect(screen.getByText(`${K}.page.empty.${filter}.description`)).toBeTruthy();
  });

  it('offers every chat the caller can see from an empty followed list', () => {
    render(<RecordChatsPage />);
    fireEvent.click(screen.getByRole('button', { name: `${K}.page.showAllICanSee` }));
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/records', search: { filter: 'all' } });
  });

  it('searches by name on the server', () => {
    render(<RecordChatsPage />);
    fireEvent.change(screen.getAllByPlaceholderText(`${K}.page.searchPlaceholder`)[0]!, { target: { value: ' acme ' } });
    expect(lastListCall()?.search).toBe('acme');
  });
});

describe('RecordChatsPage "Show in sidebar"', () => {
  const toggle = () => screen.queryByTestId('record-chats-show-in-sidebar');

  it('is not on the All tab', () => {
    render(<RecordChatsPage />);
    expect(toggle()).toBeNull();
  });

  it('is on for a type whose group is in the sidebar, and hides it', () => {
    state.search = { type: 'company' };
    render(<RecordChatsPage />);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle()!);
    expect(state.setGroupHidden).toHaveBeenCalledWith('record:company', true);
  });

  it('is off for a hidden group, and brings it back', () => {
    state.search = { type: 'task' };
    state.hidden = new Set(['record:task']);
    render(<RecordChatsPage />);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle()!);
    expect(state.setGroupHidden).toHaveBeenCalledWith('record:task', false);
  });

  it('is labelled "Show in sidebar"', () => {
    state.search = { type: 'person' };
    render(<RecordChatsPage />);
    expect(screen.getByRole('switch', { name: `${K}.page.showInSidebar` })).toBe(toggle());
  });
});

describe('RecordChatsPage rows', () => {
  const row = () => screen.getByTestId('record-chat-row');

  it('shows the record name, last message and time, and opens the chat', () => {
    state.rows = [chat()];
    render(<RecordChatsPage />);
    expect(within(row()).getByText('Acme')).toBeTruthy();
    expect(within(row()).getByText('Invoice sent')).toBeTruthy();
    expect(within(row()).getByText('sweep.weldchat.relativeTime.minutesAgo')).toBeTruthy();
    fireEvent.click(within(row()).getByText('Acme'));
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/$channelId', params: { channelId: 'ch_1' } });
  });

  it('marks an unread chat and counts its mentions', () => {
    state.rows = [chat({ lastReadAt: new Date(Date.now() - 60 * 60_000).toISOString(), unreadMentionCount: 2 })];
    render(<RecordChatsPage />);
    expect(within(row()).getByRole('img', { name: `${K}.page.filters.unread` })).toBeTruthy();
    expect(within(row()).getByLabelText(`${K}.page.mentionCount`).textContent).toBe('2');
  });

  it('does not mark a read or muted chat as unread', () => {
    state.rows = [
      chat({ id: 'ch_read' }),
      chat({ id: 'ch_muted', isMuted: true, lastReadAt: null }),
    ];
    render(<RecordChatsPage />);
    expect(screen.queryByRole('img', { name: `${K}.page.filters.unread` })).toBeNull();
  });

  it('shows the type column on the All tab only', () => {
    state.rows = [chat()];
    const { unmount } = render(<RecordChatsPage />);
    expect(within(row()).getByText(`${K}.types.company`)).toBeTruthy();
    unmount();
    state.search = { type: 'company' };
    render(<RecordChatsPage />);
    expect(within(row()).queryByText(`${K}.types.company`)).toBeNull();
  });

  it('follows a chat from "All I can see"', () => {
    state.search = { filter: 'all' };
    state.rows = [chat({ isFollowing: false, entityType: 'project', entityId: 'prj_1' })];
    render(<RecordChatsPage />);
    const follow = within(row()).getByRole('button', { name: `${K}.follow` });
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(follow);
    expect(state.follow).toHaveBeenCalledWith(
      { entityType: 'project', entityId: 'prj_1', channelId: 'ch_1' },
      expect.anything(),
    );
  });

  it('unfollows a followed chat from "All I can see"', () => {
    state.search = { filter: 'all' };
    state.rows = [chat()];
    render(<RecordChatsPage />);
    fireEvent.click(within(row()).getByRole('button', { name: `${K}.unfollow` }));
    expect(state.unfollow).toHaveBeenCalledWith(
      { entityType: 'company', entityId: 'cmp_1', channelId: 'ch_1' },
      expect.anything(),
    );
  });

  it('has no inline follow toggle under the followed filters', () => {
    state.rows = [chat()];
    render(<RecordChatsPage />);
    expect(within(row()).queryByRole('button', { name: `${K}.unfollow` })).toBeNull();
  });
});
