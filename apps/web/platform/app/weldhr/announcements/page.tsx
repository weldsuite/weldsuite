/** WeldHR — Announcements: news the HR team posts for employees, pinned ones first, with who has read each. */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BellRing, Megaphone, Pin } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { HR_ANNOUNCEMENT_PANEL_TYPE } from '@/components/objects/hr-announcement/types';
import { useDeleteHrAnnouncement, useHrAnnouncements } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { errorMessage, formatDate } from '../components/shared';
import { AnnouncementDialog } from './components/announcement-dialog';

export default function WeldHrAnnouncementsPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.announcements.title') });
  // An announcement opens in the object panel; `?stack=` keeps it deep-linkable.
  useObjectPanelUrlSync('/weldhr/announcements');
  const { open: openPanel } = useObjectPanel();
  const { can } = usePermissions();
  const canCreate = can('announcements:create');
  const canUpdate = can('announcements:update');
  const canDelete = can('announcements:delete');

  const { data, isLoading, error } = useHrAnnouncements();
  const deleteAnnouncement = useDeleteHrAnnouncement();
  const [search, setSearch] = useState('');
  const [dialogState, setDialogState] = useState<'create' | HrAnnouncement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrAnnouncement | null>(null);

  const items = useMemo(() => {
    const all = data ?? [];
    const query = search.trim().toLowerCase();
    return query ? all.filter((a) => a.title.toLowerCase().includes(query)) : all;
  }, [data, search]);

  const groups: GroupConfig<HrAnnouncement>[] = [
    { id: 'pinned', label: t('weldhr.announcements.groups.pinned'), sortOrder: 1, filter: (a) => a.pinned },
    { id: 'other', label: t('weldhr.announcements.groups.other'), sortOrder: 2, filter: (a) => !a.pinned },
  ];

  function audienceLabel(a: HrAnnouncement): string {
    return a.departmentNames.length > 0 ? a.departmentNames.join(', ') : t('weldhr.announcements.everyone');
  }

  const all = data ?? [];
  const departments = [...new Set(all.flatMap((a) => a.departmentNames))].sort((a, b) => a.localeCompare(b));
  const authors = [...new Set(all.map((a) => a.createdByName).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
  const filters: FilterConfig[] = [
    {
      field: 'audience',
      label: t('weldhr.announcements.table.audience'),
      operators: ['is'],
      options: [
        { value: '', label: t('weldhr.announcements.everyone') },
        ...departments.map((name) => ({ value: name, label: name })),
      ].map((option) => (option.value === '' ? { ...option, value: '__everyone' } : option)),
    },
    {
      field: 'pinned',
      label: t('weldhr.announcements.pinned'),
      operators: ['is'],
      options: [
        { value: 'pinned', label: t('weldhr.announcements.pinned') },
        { value: 'notPinned', label: t('weldhr.announcements.filters.notPinned') },
      ],
    },
    ...(authors.length > 0
      ? [{ field: 'postedBy', label: t('weldhr.announcements.panel.postedBy'), operators: ['is'], options: authors.map((name) => ({ value: name, label: name })) }]
      : []),
  ];
  const applyFilters = (rows: HrAnnouncement[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'audience') {
        // "Everyone" is an announcement without departments; a department also matches when it is one of several.
        return list.filter((a) => (filter.value === '__everyone' ? a.departmentNames.length === 0 : a.departmentNames.includes(filter.value)));
      }
      if (filter.field === 'pinned') return list.filter((a) => a.pinned === (filter.value === 'pinned'));
      if (filter.field === 'postedBy') return list.filter((a) => a.createdByName === filter.value);
      return list;
    }, rows);

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
          filters={filters}
          applyFilters={applyFilters}
          searchQuery={search}
          onSearchChange={setSearch}
          searchPlaceholder={t('weldhr.announcements.searchPlaceholder')}
          // A row opens the announcement's panel (details and who has read it); editing and deleting are also in its menu.
          onRowClick={(a) => openPanel({ type: HR_ANNOUNCEMENT_PANEL_TYPE, id: a.id })}
          objectPanel={{ type: HR_ANNOUNCEMENT_PANEL_TYPE }}
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
