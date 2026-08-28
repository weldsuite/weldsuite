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
  'slack',
  'team',
]);

interface InboxPageProps {
  conversationId?: string;
}

export function InboxPage({ conversationId }: InboxPageProps) {
  const selectedId =
    conversationId && !RESERVED_INBOX_SEGMENTS.has(conversationId) ? conversationId : undefined;
  const { user } = useUser();
  const router = useRouter();
  const [state, setState] = useState<DeskConversationState>('open');
  const [sort, setSort] = useState<DeskConversationSort>('newest');
  const [assigneeFilter, setAssigneeFilter] = useState<InboxAssigneeFilter>('all');

  const filters = useMemo(() => {
    if (assigneeFilter === 'mine' && user?.id) return { assigneeId: user.id };
    if (assigneeFilter === 'unassigned') return { unassigned: true };
    return {};
  }, [assigneeFilter, user?.id]);

  const handleSelect = (id: string) => {
    router.push(`/welddesk/inbox/${id}`);
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
