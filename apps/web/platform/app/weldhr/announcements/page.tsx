/** WeldHR — Announcements: news the HR team posts for employees, pinned ones first, with who has read each. */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BellRing, Megaphone, Pin } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { useDeleteHrAnnouncement, useHrAnnouncements } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { errorMessage, formatDate } from '../components/shared';
import { AnnouncementDialog } from './components/announcement-dialog';
import { AnnouncementReadsSheet } from './components/announcement-reads-sheet';

export default function WeldHrAnnouncementsPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.announcements.title') });
  const { can } = usePermissions();
  const canCreate = can('announcements:create');
  const canUpdate = can('announcements:update');
  const canDelete = can('announcements:delete');

  const { data, isLoading, error } = useHrAnnouncements();
  const deleteAnnouncement = useDeleteHrAnnouncement();
  const [search, setSearch] = useState('');
  const [dialogState, setDialogState] = useState<'create' | HrAnnouncement | null>(null);
  const [readsId, setReadsId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrAnnouncement | null>(null);

  const items = useMemo(() => {
    const all = data ?? [];
    const query = search.trim().toLowerCase();
    return query ? all.filter((a) => a.title.toLowerCase().includes(query)) : all;
  }, [data, search]);
  // Read from the list so the sheet's counts follow a refetch.
  const readsTarget = readsId ? data?.find((a) => a.id === readsId) : undefined;

  const groups: GroupConfig<HrAnnouncement>[] = [
    { id: 'pinned', label: t('weldhr.announcements.groups.pinned'), sortOrder: 1, filter: (a) => a.pinned },
    { id: 'other', label: t('weldhr.announcements.groups.other'), sortOrder: 2, filter: (a) => !a.pinned },
  ];

  function audienceLabel(a: HrAnnouncement): string {
    return a.departmentNames.length > 0 ? a.departmentNames.join(', ') : t('weldhr.announcements.everyone');
  }

  const columns: ColumnDef<HrAnnouncement>[] = [
    {
      id: 'title',
      header: t('weldhr.announcements.table.title'),
      width: HR_COL.main,
      render: (a) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            {a.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('weldhr.announcements.pinned')} />}
            <p className="truncate font-medium">{a.title}</p>
            {a.notifiedAt && (
              <BellRing className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('weldhr.announcements.pushSent')} />
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{a.body.replace(/\s+/g, ' ')}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground @4xl:hidden">
            {audienceLabel(a)} · {t('weldhr.announcements.readOf', { read: a.readCount, total: a.audienceCount })}
          </p>
        </div>
      ),
    },
    {
      id: 'audience',
      header: t('weldhr.announcements.table.audience'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[160px]'),
      render: (a) => <span className="block truncate text-muted-foreground">{audienceLabel(a)}</span>,
    },
    {
      id: 'read',
      header: t('weldhr.announcements.table.read'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[100px]'),
      render: (a) => (
        <span className="block truncate tabular-nums">{t('weldhr.announcements.readOf', { read: a.readCount, total: a.audienceCount })}</span>
      ),
    },
    {
      id: 'published',
      header: t('weldhr.announcements.table.published'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (a) => <span className="block truncate tabular-nums text-muted-foreground">{formatDate(a.publishedAt)}</span>,
    },
  ];

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrAnnouncement>
          items={items}
          isLoading={isLoading}
          error={error}
          columns={columns}
          groups={groups}
          filters={[]}
          searchQuery={search}
          onSearchChange={setSearch}
          searchPlaceholder={t('weldhr.announcements.searchPlaceholder')}
          // Opening a row shows who has read it; editing and deleting are in its menu.
          onRowClick={(a) => setReadsId(a.id)}
          onEdit={canUpdate ? setDialogState : undefined}
          onDelete={canDelete ? setDeleteTarget : undefined}
          createButton={canCreate ? { label: t('weldhr.announcements.add'), onClick: () => setDialogState('create') } : undefined}
          emptyState={{
            icon: emptyIcon(Megaphone),
            title: t('weldhr.announcements.empty.title'),
            description: t('weldhr.announcements.empty.description'),
            action: canCreate ? { label: t('weldhr.announcements.add'), onClick: () => setDialogState('create') } : undefined,
          }}
        />
      </HrListContainer>

      {dialogState && <AnnouncementDialog announcement={dialogState === 'create' ? undefined : dialogState} onClose={() => setDialogState(null)} />}

      {readsTarget && <AnnouncementReadsSheet announcement={readsTarget} onClose={() => setReadsId(null)} />}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.announcements.delete.title')}
        description={t('weldhr.announcements.delete.description', { title: deleteTarget?.title ?? '' })}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteAnnouncement.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.announcements.delete.failed')));
          }
        }}
      />
    </>
  );
}
