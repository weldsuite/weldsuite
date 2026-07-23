import { useEffect, useRef, useState } from 'react';
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
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  useDeskConversations,
  type DeskConversationFilters,
  type DeskConversationSort,
  type DeskConversationState,
} from '@/hooks/queries/use-desk-queries';
import { ConversationListItem } from './conversation-list-item';
import { BulkActionBar } from './bulk-action-bar';

interface ConversationListProps {
  filters: DeskConversationFilters;
  state: DeskConversationState;
  onStateChange: (state: DeskConversationState) => void;
  sort: DeskConversationSort;
  onSortChange: (sort: DeskConversationSort) => void;
  selectedId?: string;
  onSelect: (id: string) => void;
}

/**
 * Header (state tabs + sort dropdown) + infinite-scrolling conversation list.
 * Realtime freshness comes from the platformSyncMap's `desk_conversation` /
 * `desk_conversation_part` entries invalidating `['desk','conversations']` —
 * this component doesn't need its own subscription.
 */
export function ConversationList({
  filters,
  state,
  onStateChange,
  sort,
  onSortChange,
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

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
  const allSelected = conversations.length > 0 && conversations.every((c) => selectedIds.has(c.id));
  const selectionMode = selectedIds.size > 0;

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(conversations.map((c) => c.id)) : new Set());
  };

  return (
    <div className="w-[340px] shrink-0 border-r flex flex-col h-full">
      <div className="p-2 border-b flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0" title={t.list.selectAll}>
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) => toggleSelectAll(checked === true)}
              aria-label={t.list.selectAll}
              disabled={conversations.length === 0}
            />
          </span>
          <Tabs value={state} onValueChange={(value) => onStateChange(value as DeskConversationState)} className="flex-1">
            <TabsList className="w-full">
              <TabsTrigger value="open" className="flex-1">
                {t.tabs.open}
              </TabsTrigger>
              <TabsTrigger value="snoozed" className="flex-1">
                {t.tabs.snoozed}
              </TabsTrigger>
              <TabsTrigger value="closed" className="flex-1">
                {t.tabs.closed}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <Select value={sort} onValueChange={(value) => onSortChange(value as DeskConversationSort)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">{t.sort.newest}</SelectItem>
            <SelectItem value="oldest">{t.sort.oldest}</SelectItem>
            <SelectItem value="waiting_longest">{t.sort.waitingLongest}</SelectItem>
            <SelectItem value="priority_first">{t.sort.priorityFirst}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <BulkActionBar selectedIds={Array.from(selectedIds)} onClear={clearSelection} />

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
            selectionMode={selectionMode}
            selected={selectedIds.has(conversation.id)}
            onToggleSelected={(checked) => toggleSelected(conversation.id, checked)}
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
