import { useEffect, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Toggle } from '@weldsuite/ui/components/toggle';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import {
  ConversationList as SharedConversationList,
  type ConversationItem,
} from '@/components/shared/conversation-list';
import {
  useDeskConversations,
  type DeskConversation,
  type DeskConversationFilters,
  type DeskConversationSort,
  type DeskConversationState,
} from '@/hooks/queries/use-desk-queries';

export type InboxAssigneeFilter = 'all' | 'mine' | 'unassigned';

interface ConversationListProps {
  filters: DeskConversationFilters;
  state: DeskConversationState;
  onStateChange: (state: DeskConversationState) => void;
  sort: DeskConversationSort;
  onSortChange: (sort: DeskConversationSort) => void;
  assigneeFilter: InboxAssigneeFilter;
  onAssigneeFilterChange: (filter: InboxAssigneeFilter) => void;
  selectedId?: string;
  onSelect: (id: string) => void;
}

function conversationToItem(conversation: DeskConversation, t: ReturnType<typeof getTranslations<'deskInbox2'>>): ConversationItem {
  const waiting = Boolean(conversation.waitingSince);
  const name = conversation.name || conversation.email || t.list.noSubject;
  const subject = conversation.title || `#${conversation.conversationNumber}`;
  const preview = conversation.lastMessagePreview || conversation.title || conversation.email || '';
  const labels: string[] = [];
  const labelColors: Record<string, string> = {};

  if (conversation.channel === 'email') {
    labels.push(t.channel.email);
    labelColors[t.channel.email] = '#0f766e';
  }
  if (!conversation.assigneeId) {
    labels.push(t.list.unassignedBadge);
    labelColors[t.list.unassignedBadge] = '#6b7280';
  }
  if (waiting) {
    labels.push(t.sort.waitingLongest);
    labelColors[t.sort.waitingLongest] = '#2563eb';
  }

  return {
    id: conversation.id,
    name,
    email: conversation.email ?? undefined,
    subject,
    preview,
    date: new Date(conversation.lastMessageAt ?? conversation.updatedAt),
    isRead: !waiting,
    isStarred: false,
    hasAttachments: false,
    labels,
    labelColors,
    messageCount: 1,
    unreadCount: waiting ? 1 : 0,
  };
}

export function ConversationList({
  filters,
  state,
  onStateChange,
  sort,
  onSortChange,
  assigneeFilter,
  onAssigneeFilterChange,
  selectedId,
  onSelect,
}: ConversationListProps) {
  const t = getTranslations('deskInbox2');
  const combinedFilters: DeskConversationFilters = { ...filters, state };
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useDeskConversations(
    combinedFilters,
    sort,
  );
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const conversations = data?.pages.flatMap((page) => page.data) ?? [];
  const items = useMemo(
    () => conversations.map((conversation) => conversationToItem(conversation, t)),
    [conversations, t],
  );

  const activeFilterCount =
    (state !== 'open' ? 1 : 0) + (assigneeFilter !== 'all' ? 1 : 0) + (sort !== 'newest' ? 1 : 0);

  const filterContent = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-8 text-sm px-3 shadow-none gap-1.5',
            activeFilterCount > 0 ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {t.list.filter}
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">
              {activeFilterCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-3 space-y-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">{t.details.state}</p>
          <div className="flex flex-wrap gap-1.5">
            {([
              { value: 'open' as const, label: t.tabs.open },
              { value: 'closed' as const, label: t.tabs.closed },
            ]).map(({ value, label }) => (
              <Toggle
                key={value}
                size="sm"
                variant="outline"
                pressed={state === value}
                onPressedChange={() => onStateChange(value)}
                className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
              >
                {label}
              </Toggle>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">{t.header.assign}</p>
          <div className="flex flex-wrap gap-1.5">
            {([
              { value: 'all' as const, label: t.sidebar.all },
              { value: 'mine' as const, label: t.sidebar.yourInbox },
              { value: 'unassigned' as const, label: t.sidebar.unassigned },
            ]).map(({ value, label }) => (
              <Toggle
                key={value}
                size="sm"
                variant="outline"
                pressed={assigneeFilter === value}
                onPressedChange={() => onAssigneeFilterChange(value)}
                className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
              >
                {label}
              </Toggle>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">{t.sort.label}</p>
          <div className="flex flex-wrap gap-1.5">
            {([
              { value: 'newest' as const, label: t.sort.newest },
              { value: 'oldest' as const, label: t.sort.oldest },
              { value: 'waiting_longest' as const, label: t.sort.waitingLongest },
            ]).map(({ value, label }) => (
              <Toggle
                key={value}
                size="sm"
                variant="outline"
                pressed={sort === value}
                onPressedChange={() => onSortChange(value)}
                className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
              >
                {label}
              </Toggle>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );

  return (
    <SharedConversationList
      items={items}
      selectedId={selectedId}
      getItemUrl={(item) => `/welddesk/inbox/${item.id}`}
      onItemClick={(item) => onSelect(item.id)}
      filterContent={filterContent}
      error={isError ? t.list.loadError : null}
      isLoading={isLoading}
      emptyMessage={t.list.empty}
      footer={
        hasNextPage ? (
          <div ref={sentinelRef} className="flex items-center justify-center py-4 text-xs text-muted-foreground">
            {isFetchingNextPage && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                {t.list.loadMore}
              </>
            )}
          </div>
        ) : null
      }
    />
  );
}
