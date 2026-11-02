import { useMemo, useState } from 'react';
import { useUser } from '@/lib/auth';
import { usePathname, useRouter, useSearchParams } from '@/lib/router';
import { readInboxAssignee } from '@/app/welddesk/hooks/use-welddesk-sidebar-items';
import type { DeskConversationSort, DeskConversationState } from '@/hooks/queries/use-desk-queries';
import { DeskSplitLayout, InboxLayout } from './inbox-layout';
import { ConversationList, type InboxAssigneeFilter, type InboxTicketFilters } from './conversation-list';
import { ConversationPane } from './conversation-pane';
import { EmptyConversationPane } from './empty-conversation-pane';
import { useDeskInboxLive } from '@/hooks/welddesk/use-desk-live';
import { useDebounce } from '@/hooks/use-debounce';

const RESERVED_INBOX_SEGMENTS = new Set([
  'all',
  'archived',
  'chat',
  'discord',
  'email',
  'phone',
  'slack',
  'team',
]);

type InboxChannel = 'phone' | 'email' | 'messenger';

const CHANNEL_BY_SEGMENT: Record<string, InboxChannel | undefined> = {
  phone: 'phone',
  email: 'email',
  chat: 'messenger',
};

const SEGMENT_BY_CHANNEL: Record<InboxChannel, string> = {
  phone: 'phone',
  email: 'email',
  messenger: 'chat',
};

interface InboxPageProps {
  conversationId?: string;
  /** When set, list is filtered to this desk channel (e.g. phone inbox). */
  channel?: InboxChannel;
}

export function InboxPage({ conversationId, channel }: Readonly<InboxPageProps>) {
  const selectedId =
    conversationId && !RESERVED_INBOX_SEGMENTS.has(conversationId) ? conversationId : undefined;
  const { user } = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // In the URL, so the sidebar's "Assigned to me" / "Unassigned" open it.
  const assigneeFilter = readInboxAssignee(searchParams.get('assignee'));
  const [state, setState] = useState<DeskConversationState>('open');
  const [sort, setSort] = useState<DeskConversationSort>('newest');
  const [ticketFilters, setTicketFilters] = useState<InboxTicketFilters>({});
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  // One hub subscription for the whole inbox: list + open thread stay live.
  useDeskInboxLive();

  const channelFromSegment =
    conversationId && RESERVED_INBOX_SEGMENTS.has(conversationId)
      ? CHANNEL_BY_SEGMENT[conversationId]
      : undefined;

  const activeChannel = channel ?? channelFromSegment;

  const filters = useMemo(() => {
    const base: { assigneeId?: string; unassigned?: boolean; channel?: InboxChannel; q?: string } = {};
    if (assigneeFilter === 'mine' && user?.id) base.assigneeId = user.id;
    if (assigneeFilter === 'unassigned') base.unassigned = true;
    if (activeChannel) base.channel = activeChannel;
    if (debouncedSearch.trim()) base.q = debouncedSearch.trim();
    return base;
  }, [assigneeFilter, user?.id, activeChannel, debouncedSearch]);

  const assigneeQuery = assigneeFilter === 'all' ? '' : `?assignee=${assigneeFilter}`;

  const setAssigneeFilter = (filter: InboxAssigneeFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (filter === 'all') params.delete('assignee');
    else params.set('assignee', filter);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  // Stay in the channel inbox and assignee view the conversation was opened from.
  const handleSelect = (id: string) => {
    const base = activeChannel ? `/welddesk/inbox/${SEGMENT_BY_CHANNEL[activeChannel]}` : '/welddesk/inbox';
    router.push(`${base}/${id}${assigneeQuery}`);
  };

  return (
    <InboxLayout>
      <DeskSplitLayout
        list={
          <ConversationList
            filters={filters}
            state={state}
            onStateChange={setState}
            sort={sort}
            onSortChange={setSort}
            assigneeFilter={assigneeFilter}
            onAssigneeFilterChange={setAssigneeFilter}
            ticketFilters={ticketFilters}
            onTicketFiltersChange={setTicketFilters}
            onSearchChange={setSearch}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
        }
        detail={
          selectedId ? (
            <ConversationPane conversationId={selectedId} />
          ) : (
            <EmptyConversationPane />
          )
        }
      />
    </InboxLayout>
  );
}
