import { useMemo, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useSearch } from '@tanstack/react-router';
import { useRouter } from '@/lib/router';
import { useDeskViews, type DeskConversationSort, type DeskConversationState } from '@/hooks/queries/use-desk-queries';
import { InboxLayout } from './inbox-layout';
import { ConversationList } from './conversation-list';
import { ConversationPane } from './conversation-pane';
import { EmptyConversationPane } from './empty-conversation-pane';
import { sectionToFilters, type InboxSection } from './inbox-sidebar';
import { viewFilterToQuery } from './view-filter-to-query';

export interface InboxPageSearch {
  section?: string;
  teamId?: string;
  viewId?: string;
}

function sectionFromSearch(search: InboxPageSearch): InboxSection {
  const section = search.section ?? 'your-inbox';
  if (section === 'team' && search.teamId) return { kind: 'team', teamId: search.teamId };
  if (section === 'view' && search.viewId) return { kind: 'view', viewId: search.viewId };
  if (
    section === 'your-inbox' ||
    section === 'mentions' ||
    section === 'created-by-you' ||
    section === 'all' ||
    section === 'unassigned'
  ) {
    return { kind: section };
  }
  return { kind: 'your-inbox' };
}

interface InboxPageProps {
  /** Present when routed via /welddesk/inbox2/$conversationId. */
  conversationId?: string;
}

/**
 * Shared inbox shell for both the index route (no conversation selected —
 * shows the empty-state pane) and the $conversationId route (renders
 * <ConversationPane>). List filters + selected view/team come from URL
 * search params so the state is shareable, per the Phase 2 spec.
 */
export function InboxPage({ conversationId }: InboxPageProps) {
  const { user } = useUser();
  const router = useRouter();
  const search = useSearch({ strict: false }) as InboxPageSearch;
  const { data: viewsData } = useDeskViews();

  const [state, setState] = useState<DeskConversationState>('open');
  const [sort, setSort] = useState<DeskConversationSort>('newest');

  const section = sectionFromSearch(search);

  const filters = useMemo(() => {
    if (section.kind === 'view') {
      const view = viewsData?.data.find((v) => v.id === section.viewId);
      if (view) {
        const { filters: viewFilters } = viewFilterToQuery(view.filters);
        return viewFilters;
      }
      return {};
    }
    return sectionToFilters(section, user?.id);
  }, [section, user?.id, viewsData]);

  const handleSelect = (id: string) => {
    const params = new URLSearchParams();
    if (search.section) params.set('section', search.section);
    if (search.teamId) params.set('teamId', search.teamId);
    if (search.viewId) params.set('viewId', search.viewId);
    const qs = params.toString();
    router.push(`/welddesk/inbox2/${id}${qs ? `?${qs}` : ''}`);
  };

  return (
    <InboxLayout>
      <ConversationList
        filters={filters}
        state={state}
        onStateChange={setState}
        sort={sort}
        onSortChange={setSort}
        selectedId={conversationId}
        onSelect={handleSelect}
      />
      {conversationId ? (
        <ConversationPane
          conversationId={conversationId}
          onSelectConversation={handleSelect}
          onEscapeToList={() => router.push(`/welddesk/inbox2${window.location.search}`)}
        />
      ) : (
        <EmptyConversationPane />
      )}
    </InboxLayout>
  );
}
