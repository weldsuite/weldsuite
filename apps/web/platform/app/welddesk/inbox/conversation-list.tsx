import { useEffect, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  DESK_PRIORITIES,
  useDeskAssignment,
  useDeskAttributeOptions,
  useDeskConversations,
  useSetDeskAway,
  type DeskConversation,
  type DeskConversationFilters,
  type DeskConversationSort,
  type DeskConversationState,
} from '@/hooks/queries/use-desk-queries';

export type InboxAssigneeFilter = 'all' | 'mine' | 'unassigned';

/** The ticket-field filters: priority, type, team and tag. */
export type InboxTicketFilters = Pick<DeskConversationFilters, 'priority' | 'ticketTypeId' | 'departmentId' | 'tag'>;

/** Radix Select can't hold an empty value; this stands for "any". */
const ANY = '__any__';

const PRIORITY_COLORS = { urgent: '#dc2626', high: '#ea580c' } as const;

interface ConversationListProps {
  filters: DeskConversationFilters;
  state: DeskConversationState;
  onStateChange: (state: DeskConversationState) => void;
  sort: DeskConversationSort;
  onSortChange: (sort: DeskConversationSort) => void;
  assigneeFilter: InboxAssigneeFilter;
  onAssigneeFilterChange: (filter: InboxAssigneeFilter) => void;
  ticketFilters: InboxTicketFilters;
  onTicketFiltersChange: (filters: InboxTicketFilters) => void;
  /** Search runs server-side over every conversation, not just loaded pages. */
  onSearchChange: (query: string) => void;
  selectedId?: string;
  onSelect: (id: string) => void;
}

function conversationToItem(
  conversation: DeskConversation,
  t: ReturnType<typeof getTranslations<'deskInbox2'>>,
  typeNames: Map<string, string>,
): ConversationItem {
  const waiting = Boolean(conversation.waitingSince);
  const name = conversation.name || conversation.email || t.list.noSubject;
  const subject = conversation.title || `#${conversation.conversationNumber}`;
  const preview = conversation.lastMessagePreview || conversation.title || conversation.email || '';
  const labels: string[] = [];
  const labelColors: Record<string, string> = {};

  // Only the priorities that should catch the eye get a badge.
  if (conversation.priority === 'urgent' || conversation.priority === 'high') {
    const label = t.ticket.priorities[conversation.priority];
    labels.push(label);
    labelColors[label] = PRIORITY_COLORS[conversation.priority];
  }
  const typeName = conversation.ticketTypeId ? typeNames.get(conversation.ticketTypeId) : undefined;
  if (typeName) {
    labels.push(typeName);
    labelColors[typeName] = '#7c3aed';
  }
  for (const tag of (conversation.tags ?? []).slice(0, 2)) {
    labels.push(tag);
    labelColors[tag] = '#475569';
  }
  if (conversation.channel === 'email') {
    labels.push(t.channel.email);
    labelColors[t.channel.email] = '#0f766e';
  }
  if (conversation.channel === 'phone') {
    labels.push(t.channel.phone);
    labelColors[t.channel.phone] = '#1d4ed8';
  }
  if (conversation.channel === 'portal') {
    labels.push(t.channel.portal);
    labelColors[t.channel.portal] = '#b45309';
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

/**
 * "Available / Away" for teammates in the auto-assignment rotation: away
 * means new conversations skip you. Hidden when auto-assignment is off or
 * you aren't in the rotation.
 */
function AvailabilityToggle() {
  const t = getTranslations('deskInbox2');
  const { data: assignment } = useDeskAssignment();
  const setAway = useSetDeskAway();
  if (!assignment || assignment.mode === 'off' || !assignment.me.inRotation) return null;
  const away = assignment.me.away;

  const toggle = async () => {
    try {
      await setAway.mutateAsync(!away);
      toast.success(away ? t.assignment.nowAvailable : t.assignment.nowAway);
    } catch {
      toast.error(t.assignment.awayError);
    }
  };

  return (
    <Button
      variant="outline"
      className="h-8 px-2.5 shadow-none gap-1.5 text-sm"
      onClick={() => void toggle()}
      disabled={setAway.isPending}
      title={t.assignment.yourStatus}
      data-testid="desk-inbox-availability"
    >
      <span className={cn('h-2 w-2 rounded-full', away ? 'bg-muted-foreground/50' : 'bg-emerald-500')} />
      {away ? t.assignment.away : t.assignment.available}
    </Button>
  );
}

export function ConversationList({
  filters,
  state,
  onStateChange,
  sort,
  onSortChange,
  assigneeFilter,
  onAssigneeFilterChange,
  ticketFilters,
  onTicketFiltersChange,
  onSearchChange,
  selectedId,
  onSelect,
}: Readonly<ConversationListProps>) {
  const t = getTranslations('deskInbox2');
  const { data: options } = useDeskAttributeOptions();
  const combinedFilters: DeskConversationFilters = { ...filters, ...ticketFilters, state };
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
  const typeNames = useMemo(
    () => new Map((options?.ticketTypes ?? []).map((type) => [type.id, type.name])),
    [options?.ticketTypes],
  );
  const items = useMemo(
    () => conversations.map((conversation) => conversationToItem(conversation, t, typeNames)),
    [conversations, t, typeNames],
  );

  const activeFilterCount =
    (state !== 'open' ? 1 : 0) +
    (assigneeFilter !== 'all' ? 1 : 0) +
    (sort !== 'newest' ? 1 : 0) +
    Object.values(ticketFilters).filter(Boolean).length;

  const setTicketFilter = (key: keyof InboxTicketFilters, value: string) =>
    onTicketFiltersChange({ ...ticketFilters, [key]: value === ANY ? undefined : value });

  const ticketSelects: Array<{ key: 'ticketTypeId' | 'departmentId' | 'tag'; label: string; items: Array<{ value: string; label: string }> }> = [
    { key: 'ticketTypeId', label: t.ticket.type, items: (options?.ticketTypes ?? []).map((type) => ({ value: type.id, label: type.name })) },
    { key: 'departmentId', label: t.ticket.team, items: (options?.teams ?? []).map((team) => ({ value: team.id, label: team.name })) },
    { key: 'tag', label: t.ticket.tags, items: (options?.tags ?? []).map(({ tag }) => ({ value: tag, label: tag })) },
  ];

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
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">{t.ticket.priority}</p>
          <div className="flex flex-wrap gap-1.5" data-testid="desk-inbox-priority-filter">
            {([
              ...DESK_PRIORITIES.map((value) => ({ value, label: t.ticket.priorities[value] })),
              { value: 'none' as const, label: t.ticket.noPriority },
            ]).map(({ value, label }) => (
              <Toggle
                key={value}
                size="sm"
                variant="outline"
                pressed={ticketFilters.priority === value}
                onPressedChange={(pressed) => onTicketFiltersChange({ ...ticketFilters, priority: pressed ? value : undefined })}
                className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
              >
                {label}
              </Toggle>
            ))}
          </div>
        </div>
        {ticketSelects
          .filter(({ key, items: choices }) => choices.length > 0 || ticketFilters[key])
          .map(({ key, label, items: choices }) => (
            <div key={key}>
              <p className="text-xs font-medium text-muted-foreground mb-2">{label}</p>
              <Select value={ticketFilters[key] ?? ANY} onValueChange={(value) => setTicketFilter(key, value)}>
                <SelectTrigger className="h-7 text-xs shadow-none" data-testid={`desk-inbox-filter-${key}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>{t.ticket.any}</SelectItem>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
      </PopoverContent>
    </Popover>
  );

  return (
    <SharedConversationList
      items={items}
      selectedId={selectedId}
      getItemUrl={(item) => `/welddesk/inbox/${item.id}`}
      onItemClick={(item) => onSelect(item.id)}
      filterContent={
        <>
          {filterContent}
          <AvailabilityToggle />
        </>
      }
      onSearchChange={onSearchChange}
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
