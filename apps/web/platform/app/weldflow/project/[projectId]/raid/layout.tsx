import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAtom } from 'jotai';
import { useParams, usePathname } from '@/lib/router';
import type { RaidItem, RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { useRaidItems } from '@/hooks/queries/use-project-control-queries';
import { useProject } from '@/hooks/queries/use-projects-queries';
import { useObjectPanel } from '@/components/object-panel';
import { EMPTY_FILTERS, RAID_KINDS, RAID_KIND_PATHS, type RegisterFilters } from './_lib/raid';
import { ItemDialog, type ItemDialogState } from './_components/item-dialog';
import { RAID_ITEM_PANEL_TYPE } from './_components/raid-item-panel-type';
import { pendingRaidPanelAtom } from './_components/pending-raid-panel';
import { RaidToolbar } from './_components/raid-toolbar';
import {
  RaidContext,
  useRaidAbilities,
  useRaidMembers,
  useToday,
  type RaidContextValue,
} from './_components/raid-context';

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** The sub-tab a pathname belongs to; the risks sub-tab is the RAID root. */
function kindForPath(pathname: string, basePath: string): RaidKind {
  const rest = trimTrailingSlashes(pathname.slice(basePath.length));
  return RAID_KINDS.find((kind) => kind !== 'risk' && RAID_KIND_PATHS[kind] === rest) ?? 'risk';
}

const NO_FILTERS: Readonly<Record<RaidKind, RegisterFilters>> = {
  risk: EMPTY_FILTERS,
  assumption: EMPTY_FILTERS,
  issue: EMPTY_FILTERS,
  dependency: EMPTY_FILTERS,
};

const CLOSED_HIDDEN: Readonly<Record<RaidKind, boolean>> = { risk: false, assumption: false, issue: false, dependency: false };

function RaidProvider({ projectId, children }: Readonly<{ projectId: string; children: ReactNode }>) {
  const pathname = usePathname();
  const abilities = useRaidAbilities();
  const itemsQuery = useRaidItems(projectId);
  const projectQuery = useProject(projectId);
  const { members, memberOf } = useRaidMembers(projectId);
  const { stack, open, closeAll } = useObjectPanel();

  const [dialog, setDialog] = useState<ItemDialogState | null>(null);
  // Each sub-tab keeps its own search, filters and closed toggle while the member switches between them.
  const [filtersByKind, setFiltersByKind] = useState(NO_FILTERS);
  const [showClosedByKind, setShowClosedByKind] = useState(CLOSED_HIDDEN);

  // An item opens in the platform's object panel, like a task; the row of the item on screen stays highlighted.
  const top = stack.at(-1);
  const selectedId = top?.type === RAID_ITEM_PANEL_TYPE ? top.id : null;
  const select = useCallback(
    (id: string | null) => (id ? open({ type: RAID_ITEM_PANEL_TYPE, id }) : closeAll()),
    [open, closeAll],
  );

  // A converted item's panel, once its sub-tab shows and the panels of the page before are closed.
  const [pendingPanel, setPendingPanel] = useAtom(pendingRaidPanelAtom);
  useEffect(() => {
    if (!pendingPanel || trimTrailingSlashes(pathname) !== pendingPanel.path || stack.length > 0) return;
    setPendingPanel(null);
    open({ type: RAID_ITEM_PANEL_TYPE, id: pendingPanel.id });
  }, [pendingPanel, pathname, stack.length, open, setPendingPanel]);

  const now = useToday();
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const retry = useCallback(() => void itemsQuery.refetch(), [itemsQuery]);
  const openCreate = useCallback((kind: RaidKind) => setDialog({ mode: 'create', kind }), []);
  const openEdit = useCallback((item: RaidItem) => setDialog({ mode: 'edit', item }), []);

  const basePath = `/weldflow/project/${projectId}/raid`;
  const activeKind = kindForPath(pathname, basePath);
  const setFilters = useCallback(
    (filters: RegisterFilters) => setFiltersByKind((previous) => ({ ...previous, [activeKind]: filters })),
    [activeKind],
  );
  const toggleShowClosed = useCallback(
    () => setShowClosedByKind((previous) => ({ ...previous, [activeKind]: !previous[activeKind] })),
    [activeKind],
  );
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
    select,
    openCreate,
    openEdit,
    activeKind,
    filters: filtersByKind[activeKind],
    setFilters,
    showClosed: showClosedByKind[activeKind],
    toggleShowClosed,
  };

  return (
    <RaidContext.Provider value={value}>
      <div className="flex h-full min-h-0 flex-col">
        <RaidToolbar />
        {/* The pages pad themselves: the registers are edge-to-edge lists. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
      <ItemDialog state={dialog} onClose={() => setDialog(null)} />
    </RaidContext.Provider>
  );
}

/** The RAID tab: the toolbar with the sub-tabs and the shared register data around the sub-tab pages. */
export default function RaidLayout({ children }: Readonly<{ children: ReactNode }>) {
  const params = useParams();
  const projectId = params.projectId as string;
  // A new project starts with no dialog open.
  return (
    <RaidProvider key={projectId} projectId={projectId}>
      {children}
    </RaidProvider>
  );
}
