import { useMemo, useState } from 'react';
import { useUser } from '@/lib/auth';
import { useRouter } from '@/lib/router';
import type { DeskConversationSort, DeskConversationState } from '@/hooks/queries/use-desk-queries';
import { DeskSplitLayout, InboxLayout } from './inbox-layout';
import { ConversationList, type InboxAssigneeFilter } from './conversation-list';
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
  const [state, setState] = useState<DeskConversationState>('open');
  const [sort, setSort] = useState<DeskConversationSort>('newest');
  const [assigneeFilter, setAssigneeFilter] = useState<InboxAssigneeFilter>('all');
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

  const handleSelect = (id: string) => {
    if (activeChannel === 'phone') {
      router.push(`/welddesk/inbox/phone/${id}`);
    } else {
      router.push(`/welddesk/inbox/${id}`);
    }
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
