import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Edit, EllipsisVertical, Pin, Trash2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import {
  EntityList,
  EmptyStateIllustration,
  type ActiveFilter,
  type FilterConfig,
  type HeaderColumn,
} from '@/components/entity-list';
import { RowOverlayButton } from '@/components/shared/row-overlay-button';
import { useDebounce } from '@/hooks/use-debounce';
import {
  useDeleteDeskAnnouncement,
  useDeskAnnouncements,
  type DeskAnnouncement,
} from '@/hooks/queries/use-desk-knowledge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { ANNOUNCEMENT_STATUS_TONE, ANNOUNCEMENT_TYPE_TONE, isExpired } from './announcement-labels';

const BASE = '/welddesk/help-center/announcements';

/** The standard list row (the WeldFlow task row): one line, divider and hover, whole-row click. */
const ROW_CLASS =
  'group relative flex items-center gap-4 border-b border-gray-200/70 px-4 py-3 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50';

interface WindowLabels {
  expired: string;
  fromUntil: string;
  until: string;
  from: string;
  always: string;
}

function formatDateTime(iso: string, language: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** When an announcement is shown: expired, a window, from, until, or always. */
function shownWindow(row: DeskAnnouncement, labels: WindowLabels, language: string): string {
  if (row.status === 'published' && isExpired(row)) return labels.expired;
  const from = row.publishedAt ? formatDateTime(row.publishedAt, language) : null;
  const until = row.expiresAt ? formatDateTime(row.expiresAt, language) : null;
  if (from && until) return labels.fromUntil.replace('{from}', from).replace('{until}', until);
  if (until) return labels.until.replace('{date}', until);
  if (from) return labels.from.replace('{date}', from);
  return labels.always;
}

/** What a filter on `field` compares against. */
function filterValue(row: DeskAnnouncement, field: string): string | null {
  switch (field) {
    case 'type':
      return row.type;
    case 'status':
      return row.status;
    case 'audience':
      return row.visibility;
    default:
      return null;
  }
}

/** A megaphone with a banner, for the empty list. */
function AnnouncementsIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="14" y="20" width="92" height="22" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="14" y="20" width="92" height="22" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <circle cx="26" cy="31" r="4" className="fill-gray-300 dark:fill-white/20" opacity="0.7" />
        <rect x="36" y="29.5" width="48" height="3" rx="1.5" className="fill-gray-300 dark:fill-white/20" opacity="0.6" />
        <path
          d="M36 62 L74 50 L74 94 L36 82 Z"
          className="fill-white stroke-gray-200 dark:fill-white/[0.03] dark:stroke-white/15"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <rect x="26" y="62" width="10" height="20" rx="3" className="fill-gray-200 dark:fill-white/20" opacity="0.6" />
        <path d="M80 62 Q88 72 80 82" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="2" strokeLinecap="round" fill="none" />
        <path d="M86 56 Q98 72 86 88" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="2" strokeLinecap="round" fill="none" />
      </svg>
    </EmptyStateIllustration>
  );
}

/**
 * WeldDesk → Knowledge → Announcements: the status banners on the help center
 * and in the widget. The standard list: Filter, search and "New announcement"
 * in the toolbar, a column header, and one row per announcement that opens it.
 */
export default function AnnouncementsPage() {
  const { t, language } = useI18n();
  const a = t.helpdesk.announcementsAdmin;
  const router = useRouter();
  const canCreate = useCan('articles:create');
  const canUpdate = useCan('articles:update');
  const canDelete = useCan('articles:delete');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 250);
  const query = useDeskAnnouncements(debounced);
  const remove = useDeleteDeskAnnouncement();
  const [deleting, setDeleting] = useState<DeskAnnouncement | null>(null);

  const rows = useMemo(() => query.data?.data ?? [], [query.data]);
  const openRow = (row: DeskAnnouncement) => router.push(`${BASE}/${row.id}`);
  const create = canCreate ? () => router.push(`${BASE}/new`) : undefined;

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      { id: 'title', header: a.colTitle, width: 'flex-1 min-w-[220px]' },
      { id: 'type', header: a.colType, width: 'w-[110px]' },
      { id: 'status', header: a.colStatus, width: 'w-[120px]' },
      { id: 'audience', header: a.colAudience, width: 'hidden lg:block w-[170px]' },
      { id: 'shown', header: a.colShown, width: 'hidden xl:block w-[260px]' },
    ],
    [a],
  );

  const filterConfigs: FilterConfig[] = useMemo(
    () => [
      { field: 'type', label: a.colType, options: Object.entries(a.types).map(([value, label]) => ({ value, label })) },
      { field: 'status', label: a.colStatus, options: Object.entries(a.statuses).map(([value, label]) => ({ value, label })) },
      {
        field: 'audience',
        label: a.colAudience,
        options: Object.entries(a.visibilities).map(([value, label]) => ({ value, label })),
      },
    ],
    [a],
  );

  const applyFilters = useCallback(
    (list: DeskAnnouncement[], filters: ActiveFilter[]) =>
      list.filter((row) =>
        filters.every((filter) => {
          if (!filter.operator || !filter.value) return true;
          const value = filterValue(row, filter.field);
          if (value === null) return true;
          return filter.operator === 'is' ? value === filter.value : value !== filter.value;
        }),
      ),
    [],
  );

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(a.deleted);
      setDeleting(null);
    } catch {
      toast.error(a.deleteFailed);
    }
  };

  const renderRow = (row: DeskAnnouncement) => (
    <div key={row.id} className={`${ROW_CLASS} ${canUpdate ? 'cursor-pointer' : ''}`}>
      {canUpdate && <RowOverlayButton label={row.title} onClick={() => openRow(row)} />}
      <div className="flex min-w-[220px] flex-1 items-center gap-1.5">
        {row.isPinned && <Pin className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-label={a.window.pinned} />}
        <span className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{row.title}</span>
      </div>
      <div className="w-[110px]">
        <SoftBadge tone={ANNOUNCEMENT_TYPE_TONE[row.type] ?? 'neutral'}>
          {a.types[row.type as keyof typeof a.types] ?? row.type}
        </SoftBadge>
      </div>
      <div className="w-[120px]">
        <SoftBadge tone={ANNOUNCEMENT_STATUS_TONE[row.status] ?? 'neutral'}>
          {a.statuses[row.status as keyof typeof a.statuses] ?? row.status}
        </SoftBadge>
      </div>
      <div className="hidden w-[170px] lg:block">
        <span className="block truncate text-sm text-gray-600 dark:text-muted-foreground">
          {a.visibilities[row.visibility as keyof typeof a.visibilities] ?? row.visibility}
        </span>
      </div>
      <div className="hidden w-[260px] xl:block">
        <span className="block truncate text-sm tabular-nums text-gray-600 dark:text-muted-foreground">
          {shownWindow(row, a.window, language)}
        </span>
      </div>
      {/* h-7 holds the task row's 53px height on rows without a menu too. */}
      <div className="relative z-[1] flex h-7 w-[40px] items-center justify-end">
        {(canUpdate || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${t.common.actions.openMenu}: ${row.title}`}
                className="h-7 w-7 p-0 text-gray-400 opacity-0 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <EllipsisVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canUpdate && (
                <DropdownMenuItem onSelect={() => openRow(row)}>
                  <Edit className="mr-0.5 h-4 w-4" />
                  {a.edit}
                </DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  {canUpdate && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onSelect={() => setDeleting(row)}
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                  >
                    <Trash2 className="mr-0.5 h-4 w-4 text-destructive" />
                    {a.delete}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isError && !query.data ? (
          <ErrorState message={a.loadFailed} onRetry={() => void query.refetch()} />
        ) : (
          <EntityList<DeskAnnouncement>
            items={rows}
            isLoading={query.isLoading}
            error={null}
            headerColumns={headerColumns}
            filters={filterConfigs}
            applyFilters={applyFilters}
            renderRow={renderRow}
            searchPlaceholder={a.searchPlaceholder}
            searchFields={['title']}
            searchQuery={search}
            onSearchChange={setSearch}
            topBarClassName="pt-2 pb-2"
            createButton={create ? { label: a.newAnnouncement, onClick: create } : undefined}
            emptyState={{
              icon: <AnnouncementsIllustration />,
              title: a.emptyTitle,
              description: a.emptyDescription,
              action: create ? { label: a.newAnnouncement, onClick: create } : undefined,
            }}
            noResultsState={{ title: a.noResults, description: a.noResultsDesc }}
          />
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={a.deleteTitle}
        description={a.deleteDescription.replace('{title}', deleting?.title ?? '')}
        confirmLabel={a.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
