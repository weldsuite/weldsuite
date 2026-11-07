import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Megaphone, Pencil, Pin, Plus, Search, Trash } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
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

/** WeldDesk → Knowledge → Announcements: the status banners on the help center and in the widget. */
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

  const rows = query.data?.data ?? [];
  const dateTime = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };

  const shown = (row: DeskAnnouncement): string => {
    if (row.status === 'published' && isExpired(row)) return a.window.expired;
    if (row.publishedAt && row.expiresAt) {
      return a.window.fromUntil
        .replace('{from}', dateTime(row.publishedAt))
        .replace('{until}', dateTime(row.expiresAt));
    }
    if (row.expiresAt) return a.window.until.replace('{date}', dateTime(row.expiresAt));
    if (row.publishedAt) return a.window.from.replace('{date}', dateTime(row.publishedAt));
    return a.window.always;
  };

  const columns: ListTableColumn<DeskAnnouncement>[] = [
    {
      id: 'title',
      header: a.colTitle,
      cell: (row) => (
        <div className="min-w-0">
          <span className="flex items-center gap-1.5 font-medium">
            {row.isPinned && <Pin className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-label={a.window.pinned} />}
            <span className="truncate">{row.title}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">{row.excerpt || row.content}</span>
        </div>
      ),
    },
    {
      id: 'type',
      header: a.colType,
      width: 'w-[110px]',
      cell: (row) => (
        <SoftBadge tone={ANNOUNCEMENT_TYPE_TONE[row.type] ?? 'neutral'}>
          {a.types[row.type as keyof typeof a.types] ?? row.type}
        </SoftBadge>
      ),
    },
    {
      id: 'status',
      header: a.colStatus,
      width: 'w-[120px]',
      cell: (row) => (
        <SoftBadge tone={ANNOUNCEMENT_STATUS_TONE[row.status] ?? 'neutral'}>
          {a.statuses[row.status as keyof typeof a.statuses] ?? row.status}
        </SoftBadge>
      ),
    },
    {
      id: 'audience',
      header: a.colAudience,
      width: 'w-[170px]',
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {a.visibilities[row.visibility as keyof typeof a.visibilities] ?? row.visibility}
        </span>
      ),
    },
    {
      id: 'shown',
      header: a.colShown,
      width: 'w-[260px]',
      cell: (row) => <span className="text-sm text-muted-foreground tabular-nums">{shown(row)}</span>,
    },
  ];

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

  let content: ReactNode;
  if (query.isLoading) {
    content = <PageLoader fullScreen={false} />;
  } else if (query.isError) {
    content = <ErrorState message={a.loadFailed} onRetry={() => void query.refetch()} />;
  } else {
    content = (
      <ListTable
        columns={columns}
        data={rows}
        rowKey={(row) => row.id}
        onRowClick={canUpdate ? (row) => router.push(`${BASE}/${row.id}`) : undefined}
        rowLabel={(row) => row.title}
        actions={[
          ...(canUpdate
            ? [{ id: 'edit', label: a.edit, icon: Pencil, onClick: (row: DeskAnnouncement) => router.push(`${BASE}/${row.id}`) }]
            : []),
          ...(canDelete
            ? [
                {
                  id: 'delete',
                  label: a.delete,
                  icon: Trash,
                  variant: 'destructive' as const,
                  separatorAbove: canUpdate,
                  onClick: (row: DeskAnnouncement) => setDeleting(row),
                },
              ]
            : []),
        ]}
        emptyState={
          debounced
            ? { title: a.noResults, action: { label: a.clearSearch, onClick: () => setSearch('') } }
            : {
                icon: <Megaphone className="h-8 w-8 text-muted-foreground/60" />,
                title: a.emptyTitle,
                description: a.emptyDescription,
                ...(canCreate ? { action: { label: a.newAnnouncement, onClick: () => router.push(`${BASE}/new`) } } : {}),
              }
        }
      />
    );
  }

  return (
    <DashboardPage
      title={a.title}
      description={a.description}
      actions={
        canCreate && (
          <Button onClick={() => router.push(`${BASE}/new`)} data-testid="announcements-new">
            <Plus className="mr-1.5 h-4 w-4" />
            {a.newAnnouncement}
          </Button>
        )
      }
    >
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={a.searchPlaceholder}
          className="pl-8"
          aria-label={a.searchPlaceholder}
        />
      </div>
      {content}
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
    </DashboardPage>
  );
}
