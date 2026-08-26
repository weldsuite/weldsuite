import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  useDeskConversations,
  type DeskConversationFilters,
  type DeskConversationSort,
  type DeskConversationState,
} from '@/hooks/queries/use-desk-queries';
import { ConversationListItem } from './conversation-list-item';

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

  return (
    <div className="w-[340px] shrink-0 border-r flex flex-col h-full min-h-0">
      <div className="p-2 border-b flex flex-col gap-2">
        <Tabs value={state} onValueChange={(value) => onStateChange(value as DeskConversationState)}>
          <TabsList className="w-full">
            <TabsTrigger value="open" className="flex-1">
              {t.tabs.open}
            </TabsTrigger>
            <TabsTrigger value="closed" className="flex-1">
              {t.tabs.closed}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex gap-2">
          <Select value={assigneeFilter} onValueChange={(value) => onAssigneeFilterChange(value as InboxAssigneeFilter)}>
            <SelectTrigger className="h-8 text-xs flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t.sidebar.all}</SelectItem>
              <SelectItem value="mine">{t.sidebar.yourInbox}</SelectItem>
              <SelectItem value="unassigned">{t.sidebar.unassigned}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(value) => onSortChange(value as DeskConversationSort)}>
            <SelectTrigger className="h-8 text-xs flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">{t.sort.newest}</SelectItem>
              <SelectItem value="oldest">{t.sort.oldest}</SelectItem>
              <SelectItem value="waiting_longest">{t.sort.waitingLongest}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}
        {isError && <div className="p-4 text-sm text-destructive">{t.list.loadError}</div>}
        {!isLoading && !isError && conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-1 py-12 px-4 text-center">
            <p className="text-sm font-medium">{t.list.empty}</p>
            <p className="text-xs text-muted-foreground">{t.list.emptyDescription}</p>
          </div>
        )}
        {conversations.map((conversation) => (
          <ConversationListItem
            key={conversation.id}
            conversation={conversation}
            active={conversation.id === selectedId}
            onClick={() => onSelect(conversation.id)}
          />
        ))}
        {hasNextPage && (
          <div ref={sentinelRef} className="flex items-center justify-center py-4 text-xs text-muted-foreground">
            {isFetchingNextPage && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                {t.list.loadMore}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
