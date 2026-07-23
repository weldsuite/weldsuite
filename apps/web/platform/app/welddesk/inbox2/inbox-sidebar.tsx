import { useMemo, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { Link, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Inbox, AtSign, UserCircle, Layers, UserX, Users, Plus } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  useDeskTeams,
  useDeskViews,
  deskKeys,
  type DeskConversationFilters,
  type DeskView,
} from '@/hooks/queries/use-desk-queries';
import { ViewEditorDialog } from './view-editor-dialog';

export type InboxSection =
  | { kind: 'your-inbox' }
  | { kind: 'mentions' }
  | { kind: 'created-by-you' }
  | { kind: 'all' }
  | { kind: 'unassigned' }
  | { kind: 'team'; teamId: string }
  | { kind: 'view'; viewId: string };

/** Maps a sidebar selection to the flat filter shape useDeskConversations() expects. */
export function sectionToFilters(section: InboxSection, userId: string | null | undefined): DeskConversationFilters {
  switch (section.kind) {
    case 'your-inbox':
      return userId ? { adminAssigneeId: userId } : {};
    case 'mentions':
      return userId ? { mentionedUserId: userId } : {};
    case 'created-by-you':
      return userId ? { createdById: userId } : {};
    case 'unassigned':
      return { teamAssigneeId: 'unassigned' };
    case 'team':
      return { teamAssigneeId: section.teamId };
    case 'all':
    case 'view':
    default:
      return {};
  }
}

/** Cheap live count: a 1-item list query, reading `pagination.totalCount`. */
function useInboxCount(filters: DeskConversationFilters, enabled: boolean) {
  const { getClient } = useAppApiClient();
  const { data } = useQuery({
    queryKey: [...deskKeys.conversations(), 'count', filters],
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ state: 'open', limit: '1' });
      if (filters.adminAssigneeId) params.set('adminAssigneeId', filters.adminAssigneeId);
      if (filters.teamAssigneeId) params.set('teamAssigneeId', filters.teamAssigneeId);
      return client.get<{ pagination: { totalCount: number } }>(`/desk/conversations?${params.toString()}`);
    },
    enabled,
    staleTime: 30_000,
  });
  return data?.pagination.totalCount;
}

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  href: string;
  active: boolean;
  count?: number;
}

function SidebarItem({ icon, label, href, active, count }: SidebarItemProps) {
  return (
    <Link
      to={href}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm mx-2',
        active ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50',
      )}
    >
      <span className="shrink-0 [&_svg]:size-4">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1 text-xs">
          {count}
        </Badge>
      )}
    </Link>
  );
}

const NO_FOLDER = '__none__';

/**
 * Inbox sidebar: Your inbox / Mentions / Created by you / All / Unassigned,
 * then Team inboxes, then Views (own + shared, grouped by folder).
 *
 * Selection drives the parent route's list filters via URL search params
 * (see src/routes/welddesk/inbox2/index.tsx `section`/`teamId`/`viewId`
 * params) so the state is shareable/bookmarkable, per the Phase 2 spec.
 */
export function InboxSidebar() {
  const t = getTranslations('deskInbox2');
  const { user } = useUser();
  // strict: false — this sidebar is shared by both /welddesk/inbox2/ and
  // /welddesk/inbox2/$conversationId, which both declare the same search shape.
  const search = useSearch({ strict: false }) as {
    section?: string;
    teamId?: string;
    viewId?: string;
  };
  const activeSection = search.section ?? 'your-inbox';
  const activeKey =
    activeSection === 'team'
      ? `team:${search.teamId ?? ''}`
      : activeSection === 'view'
        ? `view:${search.viewId ?? ''}`
        : activeSection;

  const { data: teamsData } = useDeskTeams();
  const { data: viewsData } = useDeskViews();
  const [viewEditorOpen, setViewEditorOpen] = useState(false);

  const yourInboxCount = useInboxCount(user?.id ? { adminAssigneeId: user.id } : {}, !!user?.id);
  const unassignedCount = useInboxCount({ teamAssigneeId: 'unassigned' }, true);

  const viewsByFolder = useMemo(() => {
    const list = viewsData?.data ?? [];
    const byFolder = new Map<string, DeskView[]>();
    for (const view of list) {
      const key = view.folder ?? NO_FOLDER;
      const bucket = byFolder.get(key) ?? [];
      bucket.push(view);
      byFolder.set(key, bucket);
    }
    return byFolder;
  }, [viewsData]);

  const linkFor = (section: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams({ section, ...(extra ?? {}) });
    return `/welddesk/inbox2?${params.toString()}`;
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto py-3">
      <nav className="flex flex-col gap-0.5">
        <SidebarItem
          icon={<Inbox />}
          label={t.sidebar.yourInbox}
          href={linkFor('your-inbox')}
          active={activeKey === 'your-inbox'}
          count={yourInboxCount}
        />
        <SidebarItem
          icon={<AtSign />}
          label={t.sidebar.mentions}
          href={linkFor('mentions')}
          active={activeKey === 'mentions'}
        />
        <SidebarItem
          icon={<UserCircle />}
          label={t.sidebar.createdByYou}
          href={linkFor('created-by-you')}
          active={activeKey === 'created-by-you'}
        />
        <SidebarItem icon={<Layers />} label={t.sidebar.all} href={linkFor('all')} active={activeKey === 'all'} />
        <SidebarItem
          icon={<UserX />}
          label={t.sidebar.unassigned}
          href={linkFor('unassigned')}
          active={activeKey === 'unassigned'}
          count={unassignedCount}
        />
      </nav>

      {(teamsData?.data?.length ?? 0) > 0 && (
        <div className="mt-4">
          <div className="px-4 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t.sidebar.teamInboxes}
          </div>
          <nav className="flex flex-col gap-0.5">
            {teamsData!.data.map((team) => (
              <SidebarItem
                key={team.id}
                icon={<span>{team.icon || <Users />}</span>}
                label={team.name}
                href={linkFor('team', { teamId: team.id })}
                active={activeKey === `team:${team.id}`}
              />
            ))}
          </nav>
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between px-4 py-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t.sidebar.views}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => setViewEditorOpen(true)}
            aria-label={t.sidebar.newView}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {(viewsData?.data?.length ?? 0) === 0 ? (
          <div className="px-4 py-1 text-xs text-muted-foreground">{t.sidebar.noViews}</div>
        ) : (
          Array.from(viewsByFolder.entries()).map(([folder, views]) => (
            <div key={folder} className="mb-1">
              {folder !== NO_FOLDER && (
                <div className="px-4 py-0.5 text-[11px] text-muted-foreground">{folder}</div>
              )}
              <nav className="flex flex-col gap-0.5">
                {views.map((view) => (
                  <SidebarItem
                    key={view.id}
                    icon={<span>{view.icon || '📋'}</span>}
                    label={view.name}
                    href={linkFor('view', { viewId: view.id })}
                    active={activeKey === `view:${view.id}`}
                  />
                ))}
              </nav>
            </div>
          ))
        )}
      </div>

      <ViewEditorDialog open={viewEditorOpen} onOpenChange={setViewEditorOpen} />
    </div>
  );
}
