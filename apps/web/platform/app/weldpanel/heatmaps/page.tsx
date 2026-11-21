/**
 * Heatmaps: the project's page groups (URL patterns such as /products/*) as
 * the standard list, with search and a Filter for what a group covers (one
 * page or several) and when it last changed. A row opens that page group's
 * heatmap (`detail/page.tsx`); the row menu edits or deletes the group, and
 * "New page group" adds one and opens its heatmap.
 */

import { useMemo, useState } from 'react';
import { Flame } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelHeatmapPageDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import {
  useCreateWeldPanelHeatmapPage,
  useDeleteWeldPanelHeatmapPage,
  useUpdateWeldPanelHeatmapPage,
  useWeldPanelHeatmapPages,
} from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { formatDate } from '../lib/format';
import { PageGroupDialog } from './page-group-dialog';

/** Where a page group's heatmap is. */
export const heatmapHref = (pageGroupId: string) => `/weldpanel/heatmaps/${encodeURIComponent(pageGroupId)}`;

type Dialog = { mode: 'create' } | { mode: 'edit'; group: PanelHeatmapPageDto } | null;

const DAY_MS = 24 * 60 * 60_000;
/** The "Last changed" choices, as days back; `older` is everything before 90 days. */
const CHANGED_WITHIN = { last7: 7, last30: 30, last90: 90 } as const;
type Changed = keyof typeof CHANGED_WITHIN | 'older';

/** A pattern with a `*` covers several pages; without one, a single page. */
const coversSeveral = (group: PanelHeatmapPageDto) => group.urlPattern.includes('*');

/** Whether a group passes one complete pill; an unfinished pill (no value yet) lets everything through. */
export function matchesFilter(group: PanelHeatmapPageDto, filter: ActiveFilter, now = Date.now()): boolean {
  if (!filter.value) return true;
  let match = true;
  if (filter.field === 'covers') match = coversSeveral(group) === (filter.value === 'several');
  if (filter.field === 'changed') {
    const age = now - new Date(group.updatedAt).getTime();
    const value = filter.value as Changed;
    match = value === 'older' ? age > CHANGED_WITHIN.last90 * DAY_MS : age <= CHANGED_WITHIN[value] * DAY_MS;
  }
  return filter.operator === 'is not' ? !match : match;
}

function PageGroups({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language, format } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const router = useRouter();
  const canCreate = useCan('panel_reports:create');
  const canEdit = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const { data: groups, isLoading, error } = useWeldPanelHeatmapPages(projectId);
  const create = useCreateWeldPanelHeatmapPage();
  const update = useUpdateWeldPanelHeatmapPage(projectId);
  const remove = useDeleteWeldPanelHeatmapPage(projectId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleting, setDeleting] = useState<PanelHeatmapPageDto | null>(null);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const startCreating = () => setDialog({ mode: 'create' });

  const filters: FilterConfig[] = [
    {
      field: 'covers',
      label: th.filters.covers,
      options: [
        { value: 'one', label: th.filters.onePage },
        { value: 'several', label: th.filters.severalPages },
      ],
    },
    {
      field: 'changed',
      label: th.filters.changed,
      operators: ['is'],
      options: (['last7', 'last30', 'last90', 'older'] as const).map((value) => ({ value, label: th.filters[value] })),
    },
  ];
  const shown = useMemo(
    () => (groups ?? []).filter((group) => activeFilters.every((filter) => matchesFilter(group, filter))),
    [groups, activeFilters],
  );

  const columns: ColumnDef<PanelHeatmapPageDto>[] = [
    {
      id: 'name',
      header: th.columns.name,
      width: 'flex-1 min-w-[160px]',
      render: (group) => <span className="block truncate font-medium">{group.name}</span>,
    },
    {
      id: 'pattern',
      header: th.columns.pattern,
      width: 'hidden sm:block sm:w-[280px]',
      render: (group) => <span className="block truncate font-mono text-xs text-muted-foreground">{group.urlPattern}</span>,
    },
    {
      id: 'updated',
      header: th.columns.updated,
      width: 'hidden md:block md:w-[140px]',
      render: (group) => <span className="text-muted-foreground tabular-nums">{formatDate(group.updatedAt, language)}</span>,
    },
  ];

  return (
    <>
      <PanelEntityList<PanelHeatmapPageDto>
        items={shown}
        isLoading={isLoading}
        error={error}
        columns={columns}
        filters={filters}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        searchPlaceholder={th.search}
        searchFields={['name', 'urlPattern']}
        createButton={canCreate ? { label: th.newPageGroup, onClick: startCreating } : undefined}
        onRowClick={(group) => router.push(heatmapHref(group.id))}
        onEdit={canEdit ? (group) => setDialog({ mode: 'edit', group }) : undefined}
        onDelete={canDelete ? setDeleting : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Flame className="h-16 w-16 text-muted-foreground/50" />
            </EmptyStateIllustration>
          ),
          title: th.noGroupsTitle,
          description: th.noGroupsDescription,
          action: canCreate ? { label: th.newPageGroup, onClick: startCreating } : undefined,
        }}
        noResultsState={{ title: th.noMatchTitle, description: th.noMatchDescription }}
      />

      <PageGroupDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        initial={dialog?.mode === 'edit' ? { name: dialog.group.name, urlPattern: dialog.group.urlPattern } : undefined}
        onSubmit={async (values) => {
          try {
            if (dialog?.mode === 'edit') {
              await update.mutateAsync({ id: dialog.group.id, ...values });
              toast.success(th.saved);
            } else {
              const created = await create.mutateAsync({ projectId, ...values });
              toast.success(th.saved);
              router.push(heatmapHref(created.id));
            }
          } catch (err) {
            toast.error(th.saveFailed);
            throw err;
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={format(th.deleteConfirmTitle, { name: deleting?.name ?? '' })}
        description={th.deleteConfirmDescription}
        confirmLabel={th.deleteConfirm}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(th.deleted);
            setDeleting(null);
          } catch {
            toast.error(th.deleteFailed);
          }
        }}
      />
    </>
  );
}

export default function HeatmapsPage() {
  const { t } = useI18n();
  return <AnalyticsListPage title={t.weldpanel.observe.heatmaps.title}>{(project) => <PageGroups key={project.id} projectId={project.id} />}</AnalyticsListPage>;
}
