import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import type { RecordChatListItem } from '@/hooks/queries/use-weldchat-queries';

const state = vi.hoisted(() => ({
  search: {} as { type?: string; filter?: string; unread?: true },
  summary: undefined as RecordChatTypeSummary[] | undefined,
  rows: [] as unknown[],
  hidden: new Set<string>(),
  listCalls: [] as Array<{ type: string | undefined; filter: string | undefined; sort: string | undefined; search: string | undefined }>,
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
  useRecordChats: (type: string | undefined, opts: { filter?: string; sort?: string; search?: string }) => {
    state.listCalls.push({ type, filter: opts.filter, sort: opts.sort, search: opts.search });
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

const OP = 'sweep.entities.operatorIs';
const filterButtons = () => screen.getAllByRole('button', { name: /^common\.actions\.filter/ });
/** Desktop: the shared Filter (field → value → pill). */
const desktopFilterButton = () => filterButtons().find((b) => b.dataset.slot === 'popover-trigger')!;
/** Phones: a menu on the right of the toolbar, its button counting the changed filters. */
const filterButton = () => filterButtons().find((b) => b.dataset.slot === 'dropdown-menu-trigger')!;
const pills = () => [...document.querySelectorAll<HTMLElement>('[data-slot="filter-pill"]')];
const pillTexts = () => pills().map((pill) => pill.textContent);
const removePill = (pill: HTMLElement) => fireEvent.click(within(pill).getByRole('button', { name: 'Remove' }));

/** The value options of the pill's open value picker, after `first` shows. */
async function valueOptions(first: string) {
  const option = await screen.findByRole('button', { name: first });
  return [...option.parentElement!.querySelectorAll('button')];
}

describe('RecordChatsPage type filter', () => {
  it('has no tab row: the type is a filter', () => {
    render(<RecordChatsPage />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(pills()).toHaveLength(0);
    expect(lastListCall()).toEqual({ type: undefined, filter: 'following', sort: 'unread', search: '' });
  });

  it('adds a Type pill from the Filter button, one value per record type in group order', async () => {
    const user = userEvent.setup();
    render(<RecordChatsPage />);
    await user.click(desktopFilterButton());
    await user.click(await screen.findByRole('button', { name: `${K}.page.typeHeader` }));
    const options = await valueOptions(`${K}.groups.company`);
    expect(options.map((o) => o.textContent)).toEqual([
      `${K}.groups.company`,
      `${K}.groups.person`,
      `${K}.groups.task`,
      `${K}.groups.project`,
      `${K}.groups.domain`,
    ]);
    await user.click(options[1]!);
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: { type: 'person' } });
  });

  it('leaves out the types the caller has no permission for', async () => {
    const user = userEvent.setup();
    state.summary = [summaryRow('task'), summaryRow('project')];
    render(<RecordChatsPage />);
    await user.click(desktopFilterButton());
    await user.click(await screen.findByRole('button', { name: `${K}.page.typeHeader` }));
    expect((await valueOptions(`${K}.groups.task`)).map((o) => o.textContent)).toEqual([
      `${K}.groups.task`,
      `${K}.groups.project`,
    ]);
  });

  it('shows the type the URL names as a pill (a sidebar "Show all" link)', () => {
    state.search = { type: 'task' };
    render(<RecordChatsPage />);
    expect(pillTexts()).toEqual([`${K}.page.typeHeader${OP}${K}.groups.task`]);
    expect(lastListCall()?.type).toBe('task');
  });

  it('falls back to All for a type the caller may not list', () => {
    state.search = { type: 'company' };
    state.summary = [summaryRow('task')];
    render(<RecordChatsPage />);
    expect(pills()).toHaveLength(0);
    expect(lastListCall()?.type).toBeUndefined();
  });

  it('keeps the asked-for type while the summary loads', () => {
    state.search = { type: 'domain' };
    state.summary = undefined;
    render(<RecordChatsPage />);
    expect(pillTexts()).toEqual([`${K}.page.typeHeader${OP}${K}.groups.domain`]);
    expect(lastListCall()?.type).toBe('domain');
  });

  it('changes the type from its pill and keeps the filter and Unread', async () => {
    const user = userEvent.setup();
    state.search = { type: 'task', filter: 'mentions', unread: true };
    render(<RecordChatsPage />);
    await user.click(within(pills()[0]!).getByRole('button', { name: `${K}.groups.task` }));
    const options = await valueOptions(`${K}.groups.person`);
    await user.click(options.find((o) => o.textContent === `${K}.groups.person`)!);
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: '/weldchat/records',
      search: { type: 'person', filter: 'mentions', unread: true },
    });
  });

  it('takes the type off with its pill', () => {
    state.search = { type: 'person', filter: 'all' };
    render(<RecordChatsPage />);
    removePill(pills()[0]!);
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: { filter: 'all' } });
  });

  it('offers the types in the phone Filter menu too, All for no type', async () => {
    const user = userEvent.setup();
    state.search = { type: 'person' };
    render(<RecordChatsPage />);
    await user.click(filterButton());
    const group = await screen.findByRole('group', { name: `${K}.page.typeHeader` });
    const options = within(group).getAllByRole('menuitemradio');
    expect(options.map((o) => o.textContent)).toEqual([
      `${K}.page.allTab`,
      `${K}.groups.company`,
      `${K}.groups.person`,
      `${K}.groups.task`,
      `${K}.groups.project`,
      `${K}.groups.domain`,
    ]);
    expect(options[2]!.getAttribute('aria-checked')).toBe('true');
    await user.click(options[0]!);
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: {} });
  });
});

describe('RecordChatsPage filters', () => {
  /** Opens the Filter menu and returns the option of one filter. */
  async function option(user: UserEvent, filter: string) {
    await user.click(filterButton());
    return screen.findByRole('menuitemradio', { name: `${K}.page.filters.${filter}` });
  }
  /** Opens the Filter menu and returns the Unread switch. */
  async function unreadSwitch(user: UserEvent) {
    await user.click(filterButton());
    return screen.findByRole('menuitemcheckbox', { name: `${K}.page.filters.unread` });
  }
  it('lists followed chats by default, the Filter buttons plain', async () => {
    const user = userEvent.setup();
    render(<RecordChatsPage />);
    expect(filterButtons().map((b) => b.textContent)).toEqual(['common.actions.filter', 'common.actions.filter']);
    expect(pills()).toHaveLength(0);
    expect((await option(user, 'following')).getAttribute('aria-checked')).toBe('true');
    expect(lastListCall()?.filter).toBe('following');
  });

  it.each(['mentions', 'all'])('lists the "%s" filter the URL names, shown as a pill', async (filter) => {
    const user = userEvent.setup();
    state.search = { filter };
    render(<RecordChatsPage />);
    expect(pillTexts()).toEqual([`${K}.page.filterLabel${OP}${K}.page.filters.${filter}`]);
    expect((await option(user, filter)).getAttribute('aria-checked')).toBe('true');
    expect(lastListCall()?.filter).toBe(filter);
  });

  it('takes a filter off with its pill, back to Following', () => {
    state.search = { type: 'task', filter: 'mentions', unread: true };
    render(<RecordChatsPage />);
    expect(pillTexts()).toEqual([
      `${K}.page.typeHeader${OP}${K}.groups.task`,
      `${K}.page.filterLabel${OP}${K}.page.filters.mentions`,
      `${K}.page.filters.unread${OP}common.dialogs.yes`,
    ]);
    removePill(pills()[1]!);
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: { type: 'task', unread: true } });
    removePill(pills()[2]!);
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: { type: 'task', filter: 'mentions' } });
  });

  it('counts the changed filters, the type among them, on the phone Filter button', () => {
    state.search = { type: 'task', filter: 'all', unread: true };
    render(<RecordChatsPage />);
    expect(filterButton().textContent).toBe('common.actions.filter3');
  });

  it('offers Following, Mentions and All I can see, with Unread as a switch of its own', async () => {
    const user = userEvent.setup();
    render(<RecordChatsPage />);
    expect((await unreadSwitch(user)).getAttribute('aria-checked')).toBe('false');
    const show = screen.getByRole('group', { name: `${K}.page.filterLabel` });
    expect(within(show).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      `${K}.page.filters.following`,
      `${K}.page.filters.mentions`,
      `${K}.page.filters.all`,
    ]);
  });

  it('sorts the unread chats first', () => {
    render(<RecordChatsPage />);
    expect(lastListCall()?.sort).toBe('unread');
  });

  it('turns Unread on in the URL and keeps the filter', async () => {
    const user = userEvent.setup();
    state.search = { type: 'company', filter: 'all' };
    render(<RecordChatsPage />);
    await user.click(await unreadSwitch(user));
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: '/weldchat/records',
      search: { type: 'company', filter: 'all', unread: true },
    });
  });

  it('turns Unread off again', async () => {
    const user = userEvent.setup();
    state.search = { unread: true };
    render(<RecordChatsPage />);
    const unread = await unreadSwitch(user);
    expect(unread.getAttribute('aria-checked')).toBe('true');
    await user.click(unread);
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: {} });
  });

  it.each([
    ['following', 'unread'],
    ['all', 'unread'],
    ['mentions', 'mentions'],
  ])('lists the unread chats under "%s" with Unread on', (filter, listed) => {
    state.search = { filter, unread: true };
    render(<RecordChatsPage />);
    expect(pillTexts()).toContain(`${K}.page.filters.unread${OP}common.dialogs.yes`);
    expect(lastListCall()?.filter).toBe(listed);
  });

  it('shows only unread chats with Unread on, not the read ones still on screen', () => {
    state.search = { unread: true };
    state.rows = [
      chat({ id: 'ch_read', entityDisplayName: 'Read Co' }),
      chat({ id: 'ch_unread', entityDisplayName: 'Unread Co', lastReadAt: new Date(Date.now() - 60 * 60_000).toISOString() }),
      chat({ id: 'ch_muted', entityDisplayName: 'Muted Co', isMuted: true, lastReadAt: null }),
    ];
    render(<RecordChatsPage />);
    expect(screen.getAllByTestId('record-chat-row').map((r) => within(r).getByText(/Co$/).textContent)).toEqual([
      'Unread Co',
    ]);
  });

  it('keeps a muted chat with an unread mention under Mentions with Unread on', () => {
    state.search = { filter: 'mentions', unread: true };
    state.rows = [
      chat({ id: 'ch_muted', entityDisplayName: 'Muted Co', isMuted: true, lastReadAt: null, unreadMentionCount: 1 }),
      chat({ id: 'ch_read', entityDisplayName: 'Read Co' }),
    ];
    render(<RecordChatsPage />);
    expect(screen.getAllByTestId('record-chat-row').map((r) => within(r).getByText(/Co$/).textContent)).toEqual([
      'Muted Co',
    ]);
  });

  it('shows read and unread chats with Unread off', () => {
    state.rows = [
      chat({ id: 'ch_unread', lastReadAt: new Date(Date.now() - 60 * 60_000).toISOString() }),
      chat({ id: 'ch_read' }),
    ];
    render(<RecordChatsPage />);
    expect(screen.getAllByTestId('record-chat-row')).toHaveLength(2);
  });

  it('has no separate filter buttons next to the Filter menu', () => {
    render(<RecordChatsPage />);
    expect(screen.queryByRole('radio')).toBeNull();
    // The list's built-in (empty) Filter button is left out.
    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull();
  });

  it('writes the chosen filter into the URL, the default one left out', async () => {
    const user = userEvent.setup();
    state.search = { type: 'company', filter: 'mentions' };
    render(<RecordChatsPage />);
    await user.click(await option(user, 'all'));
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: { type: 'company', filter: 'all' } });
    await user.click(await option(user, 'following'));
    expect(state.navigate).toHaveBeenLastCalledWith({ to: '/weldchat/records', search: { type: 'company' } });
  });

  it.each(['following', 'mentions', 'all'])('has its own empty state under "%s"', (filter) => {
    state.search = { filter };
    render(<RecordChatsPage />);
    expect(screen.getByText(`${K}.page.empty.${filter}.title`)).toBeTruthy();
    expect(screen.getByText(`${K}.page.empty.${filter}.description`)).toBeTruthy();
  });

  it('has the unread empty state with Unread on', () => {
    state.search = { unread: true };
    render(<RecordChatsPage />);
    expect(screen.getByText(`${K}.page.empty.unread.title`)).toBeTruthy();
  });

  it('offers every chat the caller can see from an empty unread list, Unread switched off', () => {
    state.search = { unread: true };
    render(<RecordChatsPage />);
    fireEvent.click(screen.getByRole('button', { name: `${K}.page.showAllICanSee` }));
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/records', search: { filter: 'all' } });
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

  it('is not there without a type', () => {
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

  it('shows the record name and time, not the last message, and opens the chat', () => {
    state.rows = [chat()];
    render(<RecordChatsPage />);
    expect(within(row()).getByText('Acme')).toBeTruthy();
    expect(within(row()).queryByText('Invoice sent')).toBeNull();
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

  it('shows the type column without a type only', () => {
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
