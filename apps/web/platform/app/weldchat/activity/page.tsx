import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { AtSign, Check, MessageCircle, Reply, User } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useNavigate } from '@tanstack/react-router';
import {
  useChatActivity,
  useMarkActivityRead,
} from '@/hooks/queries/use-weldchat-extras-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import { renderChatTokens } from '../lib/render-tokens';
import { EntityMentionChip } from '../components/entity-mention-chip';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ListActivityQuery, ActivityItem } from '@weldsuite/core-api-client/schemas/weldchat-activity';
import {
  EmptyStateIllustration,
  EntityList,
  type ActiveFilter,
  type FilterConfig,
  type GroupConfig,
  type HeaderColumn,
  type RowHandlers,
} from '@/components/entity-list';

type ActivityFilter = NonNullable<ListActivityQuery['filter']>;

function renderWithMentions(text: string, membersMap: Map<string, string>, unknownUserLabel: string): ReactNode[] {
  return renderChatTokens(text, {
    renderUser: ({ userId, displayName }, key) => (
      <span
        key={key}
        className="inline-block bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 rounded px-1.5 py-0.5 text-[12px] font-medium align-middle"
      >
        @{displayName ?? membersMap.get(userId) ?? unknownUserLabel}
      </span>
    ),
    renderEntity: ({ entityType, label, entityId }, key) => (
      <EntityMentionChip
        key={key}
        type={entityType}
        id={entityId}
        fallbackLabel={label}
      />
    ),
    renderText: (txt, key) => <span key={key}>{txt}</span>,
  });
}

function formatRelative(
  dateStr: string | null | undefined,
  st: (key: string, params?: Record<string, unknown>) => string,
): string {
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

function activityCategory(type: string): 'mentions' | 'replies' | 'dms' | 'other' {
  const t = type.toLowerCase();
  if (t.includes('mention')) return 'mentions';
  if (t.includes('reply') || t.includes('thread')) return 'replies';
  if (t.includes('dm') || t.includes('direct')) return 'dms';
  return 'other';
}

export default function ActivityPage() {
  const t = getTranslations('weldchat');
  const st = useTranslations();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [groupBy, setGroupBy] = useState<'type' | 'none'>('type');

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    { label: t.activity ?? 'Activity' },
  ]);

  const serverFilter: ActivityFilter = useMemo(() => {
    const typeFilter = activeFilters.find(f => f.field === 'type' && f.operator === 'is');
    const v = typeFilter?.value as ActivityFilter | undefined;
    return v ?? 'all';
  }, [activeFilters]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useChatActivity(serverFilter);
  const { mutate: markRead } = useMarkActivityRead();
  const { data: membersData } = useWorkspaceMembers();

  const membersMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of (membersData as { data?: Array<{ userId?: string; name?: string }> } | undefined)?.data ?? []) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    return map;
  }, [membersData]);

  const actorsMap = useMemo(() => {
    const map = new Map<string, { name: string | null; picture: string | null }>();
    for (const m of (membersData as { data?: Array<{ userId?: string; name?: string; picture?: string | null }> } | undefined)?.data ?? []) {
      if (m.userId) map.set(m.userId, { name: m.name ?? null, picture: m.picture ?? null });
    }
    return map;
  }, [membersData]);

  const allItems: ActivityItem[] = useMemo(
    () => (data?.pages ?? []).flatMap((page) => (page as any)?.data ?? []),
    [data],
  );

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return allItems;
    const q = searchQuery.toLowerCase();
    return allItems.filter(item =>
      item.title?.toLowerCase().includes(q) ||
      item.body?.toLowerCase().includes(q) ||
      item.actorName?.toLowerCase().includes(q) ||
      item.channelName?.toLowerCase().includes(q),
    );
  }, [allItems, searchQuery]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'type',
      label: t.activityPage?.typeLabel ?? 'Type',
      options: [
        { value: 'all', label: t.activityFilters?.all ?? 'All' },
        { value: 'mentions', label: t.activityFilters?.mentions ?? 'Mentions' },
        { value: 'replies', label: t.activityFilters?.replies ?? 'Replies' },
        { value: 'dms', label: t.activityFilters?.dms ?? 'DMs' },
      ],
    },
  ], [t]);

  const groupConfigs: GroupConfig<ActivityItem>[] = useMemo(() => {
    if (groupBy === 'none') return [];
    return [
      {
        id: 'mentions',
        label: t.activityFilters?.mentions ?? 'Mentions',
        filter: (item) => activityCategory(item.type) === 'mentions',
        sortOrder: 0,
      },
      {
        id: 'replies',
        label: t.activityFilters?.replies ?? 'Replies',
        filter: (item) => activityCategory(item.type) === 'replies',
        sortOrder: 1,
      },
      {
        id: 'dms',
        label: t.activityFilters?.dms ?? 'DMs',
        filter: (item) => activityCategory(item.type) === 'dms',
        sortOrder: 2,
      },
      {
        id: 'other',
        label: t.activityPage?.otherGroup ?? 'Other',
        filter: (item) => activityCategory(item.type) === 'other',
        sortOrder: 3,
      },
    ];
  }, [groupBy, t]);

  const groupByOptions = [
    { value: 'type' as const, label: t.activityPage?.groupByType ?? 'Type' },
    { value: 'none' as const, label: t.activityPage?.groupByNone ?? 'None' },
  ];
  const groupByLabel = groupByOptions.find(o => o.value === groupBy)?.label ?? (t.activityPage?.groupByType ?? 'Type');

  const groupByMenu = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-sm px-3 shadow-none text-muted-foreground"
        >
          {groupByLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {groupByOptions.map(opt => (
          <Button
            key={opt.value}
            type="button"
            variant="ghost"
            onClick={() => setGroupBy(opt.value)}
            className={cn(
              'w-full flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-muted',
              groupBy === opt.value && 'bg-muted',
            )}
          >
            <span>{opt.label}</span>
            {groupBy === opt.value && <Check className="h-3.5 w-3.5" />}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.activityPage?.activityHeader ?? 'Activity', width: 'flex-1 min-w-0' },
    { id: 'channel', header: t.activityPage?.channelHeader ?? 'Channel', width: 'w-[160px] flex-shrink-0' },
    { id: 'last', header: t.activityPage?.whenHeader ?? 'When', width: 'w-[120px] flex-shrink-0' },
  ], [t]);

  function handleItemClick(item: ActivityItem) {
    if (!item.readAt) markRead(item.id);
    if (item.actionUrl) {
      navigate({ to: item.actionUrl as any });
    } else if (item.channelId) {
      navigate({ to: '/weldchat/$channelId', params: { channelId: item.channelId } });
    }
  }

  const renderRow = useCallback((item: ActivityItem, _handlers: RowHandlers<ActivityItem>) => {
    const isUnread = !item.readAt;
    const category = activityCategory(item.type);
    const CategoryIcon =
      category === 'mentions' ? AtSign :
      category === 'replies' ? Reply :
      category === 'dms' ? MessageCircle :
      User;

    const actor = item.actorId ? actorsMap.get(item.actorId) : undefined;
    const actorName = item.actorName ?? actor?.name ?? null;
    const actorAvatar = item.actorAvatarUrl ?? actor?.picture ?? null;

    return (
      <div
        key={item.id}
        onClick={() => handleItemClick(item)}
        className={cn(
          'flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group relative',
          isUnread && 'bg-blue-50/40 dark:bg-blue-950/20',
        )}
      >
        {isUnread && (
          <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500 rounded-r" />
        )}

        <div className="flex-1 min-w-0 flex items-center gap-3">
          <div className="relative flex-shrink-0 -top-[6px]">
            <Avatar className="h-6 w-6 !rounded-[8px]">
              {actorAvatar && (
                <AvatarImage src={actorAvatar} className="!rounded-[8px]" />
              )}
              <AvatarFallback className="text-[10px] !rounded-[8px]">
                {(actorName || '?')[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="absolute -bottom-0.5 -right-0.5 h-[12px] w-[12px] rounded-full bg-background flex items-center justify-center">
              <CategoryIcon className="h-2.5 w-2.5 text-foreground" />
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className={cn(
              'text-sm leading-snug truncate',
              isUnread ? 'font-semibold text-foreground' : 'text-foreground/80',
            )}>
              {renderWithMentions(item.title, membersMap, st('sweep.weldchat.mentionAutocomplete.unknownUser'))}
              {item.channelName && (
                <span className="font-normal text-muted-foreground"> {st('sweep.weldchat.bookmarksPanel.inChannel')} #{item.channelName}</span>
              )}
            </div>
            {item.body && (
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                {renderWithMentions(item.body, membersMap, st('sweep.weldchat.mentionAutocomplete.unknownUser'))}
              </div>
            )}
          </div>
        </div>

        <div className="w-[160px] flex-shrink-0">
          {item.channelName ? (
            <span className="text-sm text-gray-600 dark:text-muted-foreground truncate block">
              #{item.channelName}
            </span>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        <div className="w-[120px] flex-shrink-0">
          <span className="font-mono text-sm text-gray-600 dark:text-muted-foreground">
            {formatRelative(item.createdAt, st)}
          </span>
        </div>

        <div className="w-[40px] flex-shrink-0" />
      </div>
    );
  }, [membersMap, actorsMap, markRead, navigate, st]);

  const actionButtons = (
    <Button
      variant="outline"
      size="sm"
      className="h-8 text-sm px-3 shadow-none text-muted-foreground"
      onClick={() => markRead(undefined)}
    >
      <span className="hidden md:inline">{t.markAllRead ?? 'Mark all read'}</span>
    </Button>
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <EntityList<ActivityItem>
        items={filteredItems}
        isLoading={isLoading}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={3}
        renderRow={renderRow}
        leftActionButtons={groupByMenu}
        actionButtons={actionButtons}
        searchPlaceholder={t.activityPage?.searchPlaceholder ?? 'Search activity...'}
        searchFields={['title', 'body', 'actorName', 'channelName'] as (keyof ActivityItem)[]}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={() => fetchNextPage()}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" opacity="0.45">
                <circle cx="60" cy="60" r="36" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                <path d="M60 42a18 18 0 1 0 0 36 18 18 0 0 0 0-36zm-1 9.6h2v9.6l8.4 5-1 1.7L59 62.6V51.6z" className="fill-gray-300 dark:fill-white/20" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t.activityEmpty ?? 'No activity yet',
          description: t.activityEmptyHint ?? 'Mentions, thread replies, and DMs will show up here.',
        }}
        noResultsState={{
          title: t.activityPage?.noActivityFound ?? 'No activity found',
          description: t.activityPage?.noActivityFoundHint ?? "We couldn't find any activity matching your filter.",
        }}
      />
    </div>
  );
}
