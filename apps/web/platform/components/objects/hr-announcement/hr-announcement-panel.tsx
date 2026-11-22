/**
 * WeldHR announcement object panel: what was posted, for whom and when, and
 * who of the audience has read it and who has not (each employee opens their
 * own panel on top). Edit, Delete and Copy link are in its menu.
 */

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  BellRing,
  CalendarDays,
  CalendarSync,
  EllipsisVertical,
  Eye,
  EyeOff,
  LayoutGrid,
  Link as LinkIcon,
  Pencil,
  Pin,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrAnnouncementRead } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelNavigationReporter,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityList, type ActiveFilter, type FilterConfig, type HeaderColumn } from '@/components/entity-list';
import { HR_EMPLOYEE_PANEL_TYPE } from '@/components/objects/hr-employee/hr-employee-tabs';
import { PanelRow, PanelSection, RecordLoadFailed, useCopyPanelLink } from '@/components/objects/_shared/record-panel-parts';
import { PeopleIllustration, TAB_EMPTY_STATE_TABLE_CLASS, tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useDeleteHrAnnouncement, useHrAnnouncementReads, useHrAnnouncements, useHrEmployees } from '@/hooks/queries/use-weldhr-queries';
import { applySelectFilters } from '@/lib/list-filters';
import { EmployeeAvatar, errorMessage, formatDate, formatDateTime } from '@/app/weldhr/components/shared';
import { AnnouncementDialog } from '@/app/weldhr/announcements/components/announcement-dialog';
import { HR_ANNOUNCEMENT_PANEL_TYPE } from './types';

const PANEL_WIDTH = 400;
type Tab = 'overview' | 'notRead' | 'read';

/** A read-list row: the employee, with their department and photo from the employee list. */
interface ReadRow {
  id: string;
  employeeName: string;
  departmentName: string;
  avatarUrl: string | null;
  readAt: string | null;
}

/** Column widths, as the employee panel's Direct reports tab; the department gives way first in a narrow panel. */
const READ_COLUMN = {
  name: 'min-w-0 flex-1',
  department: 'w-[160px] @max-[560px]:hidden',
  readOn: 'w-[120px] @max-[400px]:w-[96px]',
};

/**
 * Who has (or has not) read the announcement, as the standard list in a panel
 * tab: Filter (department), search, the column header and a row per employee,
 * which opens their panel on top.
 */
function ReadsTab({ rows, showReadOn, emptyTitle }: Readonly<{ rows: ReadRow[]; showReadOn: boolean; emptyTitle: string }>) {
  const t = useTranslations();
  const { open } = useObjectPanel();
  // Previous / next in an employee's panel step through this list.
  const reportDisplayed = useObjectPanelNavigationReporter<ReadRow>({ type: HR_EMPLOYEE_PANEL_TYPE });

  const filterConfigs = useMemo<FilterConfig[]>(() => {
    const departments = [...new Set(rows.map((r) => r.departmentName).filter(Boolean))].sort();
    return departments.length > 0
      ? [{ field: 'department', label: t('weldhr.employees.filters.departmentLabel'), options: departments.map((d) => ({ value: d, label: d })) }]
      : [];
  }, [rows, t]);
  const applyFilters = useCallback(
    (list: ReadRow[], filters: ActiveFilter[]) => applySelectFilters(list, filters, { department: (row, value) => row.departmentName === value }),
    [],
  );

  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'name', header: t('weldhr.employees.table.name'), width: READ_COLUMN.name },
      { id: 'department', header: t('weldhr.employees.table.department'), width: READ_COLUMN.department },
      ...(showReadOn ? [{ id: 'readOn', header: t('weldhr.announcements.reads.readOn'), width: READ_COLUMN.readOn }] : []),
    ],
    [t, showReadOn],
  );

  const renderRow = useCallback(
    (row: ReadRow) => (
      <TabListRow key={row.id} label={row.employeeName} onOpen={() => open({ type: HR_EMPLOYEE_PANEL_TYPE, id: row.id, stack: true })}>
        <div className={`${READ_COLUMN.name} flex items-center gap-2`}>
          <EmployeeAvatar name={row.employeeName} src={row.avatarUrl} className="h-[18px] w-[18px] shrink-0 text-[9px]" />
          <span className="truncate text-sm font-medium text-foreground">{row.employeeName}</span>
        </div>
        <div className={`${READ_COLUMN.department} min-w-0`}>
          <span className="block truncate text-sm text-muted-foreground">{row.departmentName || '—'}</span>
        </div>
        {showReadOn && (
          <div className={`${READ_COLUMN.readOn} min-w-0`}>
            <span className="block truncate text-sm tabular-nums text-muted-foreground">{row.readAt ? formatDateTime(row.readAt) : '—'}</span>
          </div>
        )}
      </TabListRow>
    ),
    [open, showReadOn],
  );

  return (
    <TabListScope>
      <EntityList<ReadRow>
        items={rows}
        onDisplayedItemsChange={reportDisplayed}
        isLoading={false}
        error={null}
        filters={filterConfigs}
        applyFilters={applyFilters}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={t('weldhr.employees.searchPlaceholder')}
        searchFields={['employeeName', 'departmentName']}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <PeopleIllustration />, title: emptyTitle, description: '' }}
        noResultsState={{
          title: t('weldhr.announcements.reads.noResults.title'),
          description: t('weldhr.announcements.reads.noResults.description'),
        }}
      />
    </TabListScope>
  );
}

export function HrAnnouncementPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const { data, isLoading, error, refetch } = useHrAnnouncements();
  const announcement = data?.find((a) => a.id === props.id);
  const reads = useHrAnnouncementReads(props.id);
  const deleteAnnouncement = useDeleteHrAnnouncement();
  const copyLink = useCopyPanelLink('/weldhr/announcements', HR_ANNOUNCEMENT_PANEL_TYPE, props.id);
  const [tab, setTab] = useState<Tab>(props.initialTab === 'notRead' || props.initialTab === 'read' ? props.initialTab : 'overview');
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const canUpdate = can('announcements:update');
  const canDelete = can('announcements:delete');
  const shell = useObjectPanelShell({ ...props, width: PANEL_WIDTH, loading: isLoading && !data });

  // Department and photo come from the employee list (when this member may read it).
  const { data: employeesData } = useHrEmployees({ limit: 200 });
  const rows = useMemo<ReadRow[]>(() => {
    const byId = new Map((employeesData?.data ?? []).map((e) => [e.id, e]));
    return (reads.data ?? []).map((item: HrAnnouncementRead) => {
      const employee = byId.get(item.employeeId);
      return {
        id: item.employeeId,
        employeeName: item.employeeName,
        departmentName: employee?.departmentName ?? '',
        avatarUrl: employee?.avatarUrl ?? null,
        readAt: item.readAt,
      };
    });
  }, [reads.data, employeesData]);
  const read = rows.filter((row) => row.readAt);
  const notRead = rows.filter((row) => !row.readAt);
  // Until the read list is there, the counts come from the announcement itself.
  const readCount = reads.data ? read.length : (announcement?.readCount ?? 0);
  const notReadCount = reads.data ? notRead.length : Math.max(0, (announcement?.audienceCount ?? 0) - readCount);
  const tabs = [
    { id: 'overview', label: t('sweep.entities.detailsTab'), icon: LayoutGrid },
    { id: 'notRead', label: t('weldhr.announcements.reads.notReadLabel'), icon: EyeOff, count: notReadCount || undefined },
    { id: 'read', label: t('weldhr.announcements.reads.readLabel'), icon: Eye, count: readCount || undefined },
  ];

  async function confirmDelete() {
    if (!announcement) return;
    try {
      await deleteAnnouncement.mutateAsync(announcement.id);
      setConfirmingDelete(false);
      props.onClose();
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.announcements.delete.failed')));
    }
  }

  function readsBody(list: ReadRow[], showReadOn: boolean, emptyTitle: string) {
    if (reads.isLoading) {
      return (
        <div className="flex justify-center p-6">
          <InlineSpinner />
        </div>
      );
    }
    if (reads.error) {
      return (
        <RecordLoadFailed
          notFound={false}
          message={errorMessage(reads.error, t('weldhr.announcements.reads.loadFailed'))}
          retryLabel={t('common.actions.retry')}
          onRetry={() => void reads.refetch()}
        />
      );
    }
    return <ReadsTab rows={list} showReadOn={showReadOn} emptyTitle={emptyTitle} />;
  }

  const audience =
    announcement && announcement.departmentNames.length > 0 ? announcement.departmentNames.join(', ') : t('weldhr.announcements.everyone');
  const edited = announcement && announcement.updatedAt.slice(0, 10) !== announcement.publishedAt.slice(0, 10);

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        announcement ? (
          <div className="flex min-w-0 items-center gap-1.5">
            {announcement.pinned && (
              <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('weldhr.announcements.pinned')} />
            )}
            <span className="relative top-px truncate text-[15px] font-medium text-foreground">{announcement.title}</span>
          </div>
        ) : (
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
        )
      }
      actions={
        announcement ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
                aria-label={t('sweep.entities.moreActions')}
              >
                <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canUpdate && (
                <DropdownMenuItem onClick={() => setEditing(true)}>
                  <Pencil />
                  {t('weldhr.announcements.editTitle')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => void copyLink()}>
                <LinkIcon />
                {t('sweep.entities.copyLink')}
              </DropdownMenuItem>
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
                    <Trash2 />
                    {t('weldhr.common.delete')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={tabs} activeTab={tab} onChange={(next) => setTab(next as Tab)} />}
    >
      {!announcement && data && (
        <RecordLoadFailed notFound message={t('weldhr.announcements.panel.notFound')} retryLabel="" onRetry={() => {}} />
      )}
      {!announcement && !data && error && (
        <RecordLoadFailed
          notFound={false}
          message={errorMessage(error, t('weldhr.announcements.loadFailed'))}
          retryLabel={t('common.actions.retry')}
          onRetry={() => void refetch()}
        />
      )}

      {announcement && tab === 'overview' && (
        <div className="space-y-5 p-4">
          <div className="space-y-1">
            <PanelRow icon={Users} label={t('weldhr.announcements.table.audience')} value={audience} />
            <PanelRow
              icon={Eye}
              label={t('weldhr.announcements.table.read')}
              value={t('weldhr.announcements.readOf', { read: announcement.readCount, total: announcement.audienceCount })}
              tabular
            />
            <PanelRow icon={CalendarDays} label={t('weldhr.announcements.table.published')} value={formatDate(announcement.publishedAt)} tabular />
            {edited && (
              <PanelRow icon={CalendarSync} label={t('weldhr.announcements.panel.updated')} value={formatDate(announcement.updatedAt)} tabular />
            )}
            <PanelRow
              icon={BellRing}
              label={t('weldhr.announcements.panel.pushNotification')}
              value={announcement.notifiedAt ? formatDateTime(announcement.notifiedAt) : null}
              tabular
            />
            <PanelRow icon={User} label={t('weldhr.announcements.panel.postedBy')} value={announcement.createdByName} />
          </div>
          <PanelSection title={t('weldhr.announcements.panel.message')}>
            {/* Plain text from HR: keep its line breaks, never render it as markup. */}
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{announcement.body}</p>
          </PanelSection>
        </div>
      )}
      {announcement && tab === 'notRead' && readsBody(notRead, false, t('weldhr.announcements.reads.emptyNotRead'))}
      {announcement && tab === 'read' && readsBody(read, true, t('weldhr.announcements.reads.emptyRead'))}

      {editing && announcement && <AnnouncementDialog announcement={announcement} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(next) => !next && setConfirmingDelete(false)}
        title={t('weldhr.announcements.delete.title')}
        description={t('weldhr.announcements.delete.description', { title: announcement?.title ?? '' })}
        confirmLabel={t('weldhr.common.delete')}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </EntityDetailView>
  );
}
