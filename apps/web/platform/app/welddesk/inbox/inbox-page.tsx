import { useMemo, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useRouter } from '@/lib/router';
import type { DeskConversationSort, DeskConversationState } from '@/hooks/queries/use-desk-queries';
import { InboxLayout } from './inbox-layout';
import { ConversationList, type InboxAssigneeFilter } from './conversation-list';
import { ConversationPane } from './conversation-pane';
import { EmptyConversationPane } from './empty-conversation-pane';

interface InboxPageProps {
  conversationId?: string;
}

export function InboxPage({ conversationId }: InboxPageProps) {
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
      <ConversationList
        filters={filters}
        state={state}
        onStateChange={setState}
        sort={sort}
        onSortChange={setSort}
        assigneeFilter={assigneeFilter}
        onAssigneeFilterChange={setAssigneeFilter}
        selectedId={conversationId}
        onSelect={handleSelect}
      />
      {conversationId ? (
        <ConversationPane conversationId={conversationId} />
      ) : (
        <EmptyConversationPane />
      )}
    </InboxLayout>
  );
}
