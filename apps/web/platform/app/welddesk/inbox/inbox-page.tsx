import { useMemo, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useRouter } from '@/lib/router';
import type { DeskConversationSort, DeskConversationState } from '@/hooks/queries/use-desk-queries';
import { DeskSplitLayout, InboxLayout } from './inbox-layout';
import { ConversationList, type InboxAssigneeFilter } from './conversation-list';
import { ConversationPane } from './conversation-pane';
import { EmptyConversationPane } from './empty-conversation-pane';

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

interface InboxPageProps {
  conversationId?: string;
  /** When set, list is filtered to this desk channel (e.g. phone inbox). */
  channel?: 'phone' | 'email' | 'messenger';
}

export function InboxPage({ conversationId, channel }: InboxPageProps) {
  const selectedId =
    conversationId && !RESERVED_INBOX_SEGMENTS.has(conversationId) ? conversationId : undefined;
  const { user } = useUser();
  const router = useRouter();
  const [state, setState] = useState<DeskConversationState>('open');
  const [sort, setSort] = useState<DeskConversationSort>('newest');
  const [assigneeFilter, setAssigneeFilter] = useState<InboxAssigneeFilter>('all');

  const channelFromSegment =
    conversationId && RESERVED_INBOX_SEGMENTS.has(conversationId)
      ? conversationId === 'phone'
        ? ('phone' as const)
        : conversationId === 'email'
          ? ('email' as const)
          : conversationId === 'chat'
            ? ('messenger' as const)
            : undefined
      : undefined;

  const activeChannel = channel ?? channelFromSegment;

  const filters = useMemo(() => {
    const base: { assigneeId?: string; unassigned?: boolean; channel?: typeof activeChannel } = {};
    if (assigneeFilter === 'mine' && user?.id) base.assigneeId = user.id;
    if (assigneeFilter === 'unassigned') base.unassigned = true;
    if (activeChannel) base.channel = activeChannel;
    return base;
  }, [assigneeFilter, user?.id, activeChannel]);

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
