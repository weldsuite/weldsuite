import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Bell, BellOff, Check, EllipsisVertical, ExternalLink, MessagesSquare, Plus, Search, UserMinus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import {
  FilterAddButton,
  FilterButton,
  FilterPill,
  FilterPillDivider,
  FilterPillLabel,
  FilterPillRemove,
} from '@weldsuite/ui/components/filter-button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useObjectPanel } from '@/components/object-panel';
import { EntityList, EmptyStateIllustration, type HeaderColumn } from '@/components/entity-list';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';
import {
  useFollowRecordChat,
  useMuteChannel,
  useRecordChats,
  useRecordChatSummary,
  useUnfollowRecordChat,
  useWorkspaceMembers,
  type RecordChatListItem,
} from '@/hooks/queries/use-weldchat-queries';
import { useGroupHidden } from '../hooks/use-group-hidden';
import { messagePreviewText } from '../lib/render-message-content';
import { isUnreadRecordChat, uniqueRows } from '../lib/record-chat-groups';
import {
  getRecordChatTypeInfo,
  openRecordPanel,
  recordGroupKey,
  RECORD_CHATS_PAGE_PATH,
} from '../lib/record-chat-types';
import {
  DEFAULT_RECORD_CHAT_FILTER,
  parseRecordChatsSearch,
  permittedRecordChatTypes,
  RECORD_CHAT_FILTER_LABEL_KEYS,
  RECORD_CHAT_SCOPES,
  recordChatsEmptyKeys,
  recordChatsListFilter,
  resolveRecordChatsType,
  type RecordChatFilter,
  type RecordChatsSearch,
} from '../lib/record-chats-page';

type Translate = (key: string, params?: Record<string, unknown>) => string;

const P = 'sweep.weldchat.recordChats.page';
const ALL_TAB = 'all';

function formatRelative(dateStr: string | null | undefined, st: Translate): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  if (diff < 0) return st('sweep.weldchat.relativeTime.justNow');
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return st('sweep.weldchat.relativeTime.justNow');
  if (mins < 60) return st('sweep.weldchat.relativeTime.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return st('sweep.weldchat.relativeTime.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return st('sweep.weldchat.relativeTime.daysAgo', { count: days });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function recordChatName(chat: Pick<RecordChatListItem, 'entityDisplayName' | 'name'>): string {
  return chat.entityDisplayName || chat.name || '';
}

/** The record's picture when the chat carries one, otherwise its type's icon. */
function RecordChatAvatar({ chat }: Readonly<{ chat: RecordChatListItem }>) {
  const Icon = getRecordChatTypeInfo(chat.entityType)?.icon ?? MessagesSquare;
  const picture = typeof chat.icon === 'string' && /^https?:\/\//.test(chat.icon) ? chat.icon : null;
  if (picture) {
    return (
      <Avatar className="h-6 w-6 flex-shrink-0">
        <AvatarImage src={picture} />
        <AvatarFallback>
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[8px] bg-muted">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    </span>
  );
}

/** A filter changed from its default, styled as the list's filter pills, with a button to take it off. */
function RecordFilterPill({
  label,
  value,
  removeLabel,
  onRemove,
}: Readonly<{ label?: string; value: string; removeLabel: string; onRemove: () => void }>) {
  return (
    <FilterPill data-testid="record-chats-filter-pill">
      {label && (
        <>
          <FilterPillLabel>{label}</FilterPillLabel>
          <FilterPillDivider />
        </>
      )}
      <span className="whitespace-nowrap px-2 text-foreground">{value}</span>
      <FilterPillDivider />
      <FilterPillRemove onClick={onRemove} aria-label={removeLabel} />
    </FilterPill>
  );
}

/**
 * Every record chat the caller follows or may read, beyond the five per type
 * the sidebar shows: a tab per record type, the Following / Mentions / All I
 * can see filters with an Unread switch on top, search by name, unread chats
 * first and then newest activity first.
 */
export default function RecordChatsPage() {
  const st = useTranslations();
  const navigate = useNavigate();
  const search: RecordChatsSearch = useSearch({ from: '/weldchat/records/' });
  const scope = search.filter ?? DEFAULT_RECORD_CHAT_FILTER;
  const unreadOnly = search.unread === true;
  const filter = recordChatsListFilter(scope, unreadOnly);
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery.trim(), 300);

  const { data: summaryData } = useRecordChatSummary();
  const permittedTypes = useMemo(() => permittedRecordChatTypes(summaryData?.data), [summaryData]);
  const activeType = resolveRecordChatsType(search.type, permittedTypes);
  const activeInfo = getRecordChatTypeInfo(activeType);

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    activeInfo
      ? { label: st('sweep.weldchat.recordChats.title'), href: RECORD_CHATS_PAGE_PATH }
      : { label: st('sweep.weldchat.recordChats.title') },
    ...(activeInfo ? [{ label: st(activeInfo.groupLabelKey) }] : []),
  ]);

  const list = useRecordChats(activeType, { filter, sort: 'unread', search: debouncedSearch, keepPrevious: true });
  // With Unread on, a chat read since it loaded, or a read row of the list
  // still showing while this one loads, is left out. Under Mentions that is
  // a chat without an unread mention: a muted chat can still hold one.
  const rows = useMemo(() => {
    const all = uniqueRows(list.data?.pages ?? []);
    if (!unreadOnly) return all;
    return all.filter((chat) =>
      filter === 'mentions' ? (chat.unreadMentionCount ?? 0) > 0 : chat.isFollowing && isUnreadRecordChat(chat),
    );
  }, [list.data, unreadOnly, filter]);

  const { data: membersData } = useWorkspaceMembers();
  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersData?.data ?? []) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    return map;
  }, [membersData]);

  const { mutate: follow } = useFollowRecordChat();
  const { mutate: unfollow } = useUnfollowRecordChat();
  const { mutate: muteChannel } = useMuteChannel();
  const { open: openObjectPanel } = useObjectPanel();
  // A sheet's or a document's chat opens its page.
  const push = useCallback((href: string) => void navigate({ to: href }), [navigate]);
  const { isGroupHidden, setGroupHidden } = useGroupHidden();

  /** Changes the type tab, filter or Unread switch in the URL; the defaults are left out. */
  const go = useCallback(
    (patch: { type?: string; filter?: string; unread?: boolean }) => {
      void navigate({
        to: RECORD_CHATS_PAGE_PATH,
        search: parseRecordChatsSearch({ type: activeType, filter: scope, unread: unreadOnly, ...patch }),
      });
    },
    [navigate, activeType, scope, unreadOnly],
  );

  const setFollowing = useCallback(
    (chat: RecordChatListItem, following: boolean) => {
      const info = getRecordChatTypeInfo(chat.entityType);
      if (!info) return;
      const variables = { entityType: info.type, entityId: chat.entityId, channelId: chat.id };
      if (following) {
        follow(variables, { onError: () => toast.error(st('sweep.weldchat.recordChats.followFailed')) });
      } else {
        unfollow(variables, { onError: () => toast.error(st('sweep.weldchat.recordChats.unfollowFailed')) });
      }
    },
    [follow, unfollow, st],
  );

  // A chat the caller does not follow is still theirs to read (reading follows
  // access to the record), so every row opens the chat.
  const openChat = useCallback(
    (chat: RecordChatListItem) => navigate({ to: '/weldchat/$channelId', params: { channelId: chat.id } }),
    [navigate],
  );

  const tabs: PageTab[] = useMemo(() => {
    // Until the summary says which types the caller may list, show the asked-for one.
    const types = permittedTypes ?? (activeType ? [activeType] : []);
    return [
      { id: ALL_TAB, label: st(`${P}.allTab`) },
      ...types.flatMap((type) => {
        const info = getRecordChatTypeInfo(type);
        return info ? [{ id: type, label: st(info.groupLabelKey), icon: info.icon }] : [];
      }),
    ];
  }, [permittedTypes, activeType, st]);

  const groupKey = activeType ? recordGroupKey(activeType) : null;
  const sidebarToggle = groupKey ? (
    <label className="ml-auto flex flex-shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap pb-2 pl-3 text-sm text-muted-foreground">
      <Switch
        checked={!isGroupHidden(groupKey)}
        onCheckedChange={(shown) => setGroupHidden(groupKey, !shown)}
        data-testid="record-chats-show-in-sidebar"
      />
      {st(`${P}.showInSidebar`)}
    </label>
  ) : null;

  const filterLabel = (value: RecordChatFilter) => st(RECORD_CHAT_FILTER_LABEL_KEYS[value]);

  const scopeChanged = scope !== DEFAULT_RECORD_CHAT_FILTER;
  const changedFilterCount = Number(scopeChanged) + Number(unreadOnly);

  /** The Filter menu, opened from `trigger`. */
  const filterMenu = (trigger: ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>{st(`${P}.filterLabel`)}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={scope}
          onValueChange={(value) => go({ filter: value })}
          aria-label={st(`${P}.filterLabel`)}
        >
          {RECORD_CHAT_SCOPES.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {filterLabel(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={unreadOnly} onCheckedChange={(checked) => go({ unread: checked })}>
          {filterLabel('unread')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Like the list's own Filter button: plain while every filter is at its
  // default, then a pill per changed filter and a "+" to change them again.
  const filterBar =
    changedFilterCount === 0 ? (
      filterMenu(<FilterButton>{st('common.actions.filter')}</FilterButton>)
    ) : (
      <div className="flex items-center gap-2">
        {scopeChanged && (
          <RecordFilterPill
            label={st(`${P}.filterLabel`)}
            value={filterLabel(scope)}
            removeLabel={st(`${P}.removeFilter`, { name: filterLabel(scope) })}
            onRemove={() => go({ filter: DEFAULT_RECORD_CHAT_FILTER })}
          />
        )}
        {unreadOnly && (
          <RecordFilterPill
            value={filterLabel('unread')}
            removeLabel={st(`${P}.removeFilter`, { name: filterLabel('unread') })}
            onRemove={() => go({ unread: false })}
          />
        )}
        {filterMenu(<FilterAddButton aria-label={st('common.actions.filter')} />)}
      </div>
    );

  // The toolbar's left side is desktop only; phones get the menu on the right,
  // its button counting the changed filters.
  const mobileFilter = (
    <div className="md:hidden">
      {filterMenu(<FilterButton count={changedFilterCount}>{st('common.actions.filter')}</FilterButton>)}
    </div>
  );

  const showType = !activeType;
  const showFollow = filter === 'all';

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      { id: 'name', header: st(`${P}.nameHeader`), width: 'flex-1 min-w-0' },
      ...(showType ? [{ id: 'type', header: st(`${P}.typeHeader`), width: 'w-[120px] flex-shrink-0' }] : []),
      { id: 'last', header: st(`${P}.lastActivityHeader`), width: 'w-[110px] flex-shrink-0' },
      ...(showFollow ? [{ id: 'follow', header: '', width: 'w-[28px] flex-shrink-0' }] : []),
    ],
    [showType, showFollow, st],
  );

  const renderRow = useCallback(
    (chat: RecordChatListItem) => {
      const info = getRecordChatTypeInfo(chat.entityType);
      const TypeIcon = info?.icon ?? MessagesSquare;
      const name = recordChatName(chat);
      const unread = chat.isFollowing && isUnreadRecordChat(chat);
      const mentions = chat.unreadMentionCount ?? 0;
      const preview = chat.lastMessagePreview ? messagePreviewText(chat.lastMessagePreview, memberNames) : '';

      return (
        <div
          key={chat.id}
          data-testid="record-chat-row"
          className="group flex items-center gap-4 border-b border-gray-200/70 px-4 py-3 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50"
        >
          <button
            type="button"
            onClick={() => openChat(chat)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 text-left"
          >
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <RecordChatAvatar chat={chat} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      'truncate text-sm',
                      unread ? 'font-semibold text-foreground' : 'font-medium text-gray-900 dark:text-foreground',
                    )}
                  >
                    {name}
                  </span>
                  {chat.isMuted && (
                    <BellOff className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-label={st(`${P}.muted`)} />
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {preview || st(`${P}.noMessages`)}
                </span>
              </span>
              {mentions > 0 && (
                <span
                  className="flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
                  aria-label={st(`${P}.mentionCount`, { count: mentions })}
                >
                  {mentions}
                </span>
              )}
              {unread && (
                <span
                  role="img"
                  className="h-2 w-2 flex-shrink-0 rounded-full bg-blue-500"
                  aria-label={st(RECORD_CHAT_FILTER_LABEL_KEYS.unread)}
                />
              )}
            </span>

            {showType && (
              <span className="hidden w-[120px] min-w-0 flex-shrink-0 items-center gap-1.5 text-sm text-gray-600 md:flex dark:text-muted-foreground">
                <TypeIcon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{info ? st(info.labelKey) : chat.entityType}</span>
              </span>
            )}

            <span className="w-[110px] flex-shrink-0 text-sm tabular-nums text-gray-600 dark:text-muted-foreground">
              {formatRelative(chat.lastMessageAt, st)}
            </span>
          </button>

          {showFollow && (
            <div className="flex w-[28px] flex-shrink-0 justify-center">
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 w-7 p-0', chat.isFollowing ? 'text-muted-foreground' : 'text-foreground')}
                aria-pressed={chat.isFollowing}
                aria-label={st(
                  chat.isFollowing ? 'sweep.weldchat.recordChats.unfollow' : 'sweep.weldchat.recordChats.follow',
                )}
                title={st(
                  chat.isFollowing ? 'sweep.weldchat.recordChats.unfollow' : 'sweep.weldchat.recordChats.followHint',
                )}
                onClick={() => setFollowing(chat, !chat.isFollowing)}
              >
                {chat.isFollowing ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
          )}

          <div className="flex w-[40px] flex-shrink-0 justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={st(`${P}.rowActions`, { name })}
                >
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {chat.isFollowing ? (
                  <DropdownMenuItem onClick={() => setFollowing(chat, false)}>
                    <UserMinus className="mr-0.5 h-4 w-4" />
                    {st('sweep.weldchat.recordChats.unfollow')}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => setFollowing(chat, true)}>
                    <UserPlus className="mr-0.5 h-4 w-4" />
                    {st('sweep.weldchat.recordChats.follow')}
                  </DropdownMenuItem>
                )}
                {/* Muting is a setting on the caller's follow, so only a followed chat has it. */}
                {chat.isFollowing && (
                  <DropdownMenuItem onClick={() => muteChannel({ channelId: chat.id, mute: !chat.isMuted })}>
                    {chat.isMuted ? <Bell className="mr-0.5 h-4 w-4" /> : <BellOff className="mr-0.5 h-4 w-4" />}
                    {st(chat.isMuted ? 'sweep.weldchat.sidebar.unmute' : 'sweep.weldchat.sidebar.mute')}
                  </DropdownMenuItem>
                )}
                {info && chat.entityId && (
                  <DropdownMenuItem onClick={() => openRecordPanel(openObjectPanel, info.type, chat.entityId, push)}>
                    <ExternalLink className="mr-0.5 h-4 w-4" />
                    {st(info.openLabelKey)}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      );
    },
    [memberNames, showType, showFollow, openChat, setFollowing, muteChannel, openObjectPanel, push, st],
  );

  const emptyKeys = recordChatsEmptyKeys(filter);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageTabs
        tabs={tabs}
        activeTab={activeType ?? ALL_TAB}
        onTabChange={(id) => go({ type: id === ALL_TAB ? undefined : id })}
        overflow="dropdown"
        className="flex-shrink-0 pt-3"
        innerClassName="px-4"
      >
        {sidebarToggle}
      </PageTabs>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EntityList<RecordChatListItem>
          items={rows}
          isLoading={list.isLoading}
          error={list.error}
          headerColumns={headerColumns}
          filters={[]}
          hideFilter
          renderRow={renderRow}
          leftActionButtons={filterBar}
          actionButtons={mobileFilter}
          searchPlaceholder={st(`${P}.searchPlaceholder`)}
          searchFields={['entityDisplayName'] as (keyof RecordChatListItem)[]}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          // Rows of the previous tab, filter or search fade until the new ones arrive.
          itemsClassName={cn('transition-opacity', list.isPlaceholderData && 'opacity-60')}
          hasMore={!!list.hasNextPage && !list.isPlaceholderData}
          isLoadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" opacity="0.45">
                  <rect x="26" y="34" width="56" height="40" rx="10" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                  <path d="M40 74l-8 10v-10z" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" strokeLinejoin="round" />
                  <rect x="38" y="47" width="32" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
                  <rect x="38" y="57" width="22" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
                  <rect x="64" y="58" width="30" height="30" rx="8" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                  <rect x="72" y="66" width="14" height="14" rx="2" className="fill-gray-200 dark:fill-white/15" />
                </svg>
              </EmptyStateIllustration>
            ),
            title: st(emptyKeys.title),
            description: st(emptyKeys.description),
            secondaryAction:
              filter === 'all'
                ? undefined
                : { label: st(`${P}.showAllICanSee`), onClick: () => go({ filter: 'all', unread: false }) },
          }}
          noResultsState={{
            icon: <Search className="h-4 w-4 text-gray-400" />,
            title: st(`${P}.noMatches`),
            description: st(`${P}.noMatchesHint`),
          }}
        />
      </div>
    </div>
  );
}
