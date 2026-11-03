import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isSameDay } from 'date-fns';
import { Link, useParams, usePathname } from '@/lib/router';
import { usePermissions } from '@weldsuite/permissions/react';
import type { RaidItem, RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useRaidItems } from '@/hooks/queries/use-project-control-queries';
import { useProject, useProjectMembers } from '@/hooks/queries/use-projects-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { RAID_KINDS, RAID_KIND_PATHS, itemsOfKind } from './_lib/raid';
import { isOpenItem } from './_lib/risk';
import { ItemDialog, type ItemDialogState } from './_components/item-dialog';
import { RaidDetailPanel } from './_components/raid-detail-panel';
import { RaidContext, type RaidAbilities, type RaidContextValue, type RaidMember } from './_components/raid-context';

/** The sub-tab a pathname belongs to; the risks sub-tab is the RAID root. */
function kindForPath(pathname: string, basePath: string): RaidKind {
  const rest = pathname.slice(basePath.length).replace(/\/+$/, '');
  return RAID_KINDS.find((kind) => kind !== 'risk' && RAID_KIND_PATHS[kind] === rest) ?? 'risk';
}

/** Items a sub-tab counts: open risks, issues and dependencies; every assumption (validated and wrong ones stay listed). */
function tabCount(items: readonly RaidItem[], kind: RaidKind): number {
  const ofKind = itemsOfKind(items, kind);
  return kind === 'assumption' ? ofKind.length : ofKind.filter(isOpenItem).length;
}

/**
 * Today, as a stable value: every "overdue" and "in 3 days" on a screen is
 * worked out from it, and it moves on only when the calendar day changes.
 */
function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setToday((previous) => (isSameDay(previous, new Date()) ? previous : new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return today;
}

function useRaidAbilities(): RaidAbilities {
  const { canWrite } = useProjectPermissions();
  const { can } = usePermissions();
  const update = canWrite && can('projects:update');
  return {
    create: canWrite && can('projects:create'),
    update,
    remove: canWrite && can('projects:delete'),
    createTasks: update && can('tasks:create'),
    updateTasks: update && can('tasks:update'),
  };
}

function SubTabs({
  projectId,
  items,
  activeKind,
  loaded,
}: Readonly<{ projectId: string; items: readonly RaidItem[]; activeKind: RaidKind; loaded: boolean }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const basePath = `/weldflow/project/${projectId}/raid`;
  return (
    <nav aria-label={copy.subNavLabel} className="flex gap-1.5 overflow-x-auto px-3 pb-2.5 md:px-4">
      {RAID_KINDS.map((kind) => {
        const active = kind === activeKind;
        return (
          <Link
            key={kind}
            href={`${basePath}${RAID_KIND_PATHS[kind]}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] whitespace-nowrap outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'bg-foreground font-medium text-background' : 'text-foreground/80 hover:bg-accent',
            )}
          >
            {copy.tabs[kind]}
            {loaded ? (
              <span className={cn('tabular-nums', active ? 'opacity-75' : 'text-muted-foreground')}>{tabCount(items, kind)}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function RaidProvider({ projectId, children }: Readonly<{ projectId: string; children: ReactNode }>) {
  const pathname = usePathname();
  const abilities = useRaidAbilities();
  const itemsQuery = useRaidItems(projectId);
  const projectQuery = useProject(projectId);
  const membersQuery = useProjectMembers(projectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ItemDialogState | null>(null);

  const members = useMemo<RaidMember[]>(
    () =>
      (membersQuery.data?.data ?? [])
        .filter((member) => member.isActive !== false && !member.leftAt)
        .map((member) => ({
          userId: member.userId,
          name: member.user?.name || member.user?.email || member.userId,
          email: member.user?.email ?? null,
          avatar: member.user?.avatar ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [membersQuery.data],
  );
  const memberById = useMemo(() => new Map(members.map((member) => [member.userId, member])), [members]);
  const memberOf = useCallback((userId: string | null) => (userId ? (memberById.get(userId) ?? null) : null), [memberById]);

  const now = useToday();
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const retry = useCallback(() => void itemsQuery.refetch(), [itemsQuery]);
  const openCreate = useCallback((kind: RaidKind) => setDialog({ mode: 'create', kind }), []);
  const openEdit = useCallback((item: RaidItem) => setDialog({ mode: 'edit', item }), []);

  const basePath = `/weldflow/project/${projectId}/raid`;
  const value: RaidContextValue = {
    projectId,
    projectName: projectQuery.data?.data?.name ?? '',
    items,
    isLoading: itemsQuery.isLoading,
    isError: itemsQuery.isError && !itemsQuery.data,
    retry,
    now,
    members,
    memberOf,
    abilities,
    selectedId,
    select: setSelectedId,
    openCreate,
    openEdit,
  };

  return (
    <RaidContext.Provider value={value}>
      <div className="relative flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col pt-3">
          <SubTabs projectId={projectId} items={items} activeKind={kindForPath(pathname, basePath)} loaded={!itemsQuery.isLoading && !!itemsQuery.data} />
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-8 md:px-4">{children}</div>
        </div>
        {selectedId ? (
          <aside
            key={selectedId}
            className="absolute inset-0 z-20 flex flex-col bg-background lg:static lg:inset-auto lg:z-auto lg:w-[32.5rem] lg:shrink-0 lg:border-l xl:w-[35rem]"
          >
            <RaidDetailPanel itemId={selectedId} />
          </aside>
        ) : null}
      </div>
      <ItemDialog state={dialog} onClose={() => setDialog(null)} />
    </RaidContext.Provider>
  );
}

/** The RAID tab: sub-tabs, the shared register data and the detail panel around the sub-tab pages. */
export default function RaidLayout({ children }: Readonly<{ children: ReactNode }>) {
  const params = useParams();
  const projectId = params.projectId as string;
  // A new project starts with nothing selected and no dialog open.
  return (
    <RaidProvider key={projectId} projectId={projectId}>
      {children}
    </RaidProvider>
  );
}
