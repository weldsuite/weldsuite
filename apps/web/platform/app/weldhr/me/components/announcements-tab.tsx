/**
 * My HR → Announcements: what the HR team posted for you, pinned first, in the
 * standard list. A row opens the announcement in its panel, which marks it as
 * read; one you have not opened yet says "New" (and the sidebar item counts it).
 */

import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Check, Megaphone, Pin } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';
import { useObjectPanel } from '@/components/object-panel';
import { MY_ANNOUNCEMENT_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useMyHrAnnouncements, useMyHrMarkAnnouncementRead } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { errorMessage, formatDate } from '../../components/shared';

/** Marks an announcement as read once (a refetch in flight does not send it twice), with a toast when that fails. */
export function useMarkMyAnnouncementRead() {
  const t = useTranslations();
  const { mutate } = useMyHrMarkAnnouncementRead();
  const requested = useRef(new Set<string>());
  return useCallback(
    (announcement: HrSelfAnnouncement) => {
      if (announcement.readAt || requested.current.has(announcement.id)) return;
      requested.current.add(announcement.id);
      mutate(announcement.id, {
        onError: (err) => {
          requested.current.delete(announcement.id);
          toast.error(errorMessage(err, t('weldhr.me.announcements.markReadFailed')));
        },
      });
    },
    [mutate, t],
  );
}

/** "New" for one you have not opened yet, otherwise a muted "Read". */
export function AnnouncementReadState({ announcement }: Readonly<{ announcement: HrSelfAnnouncement }>) {
  const t = useTranslations();
  return announcement.readAt ? (
    <span className="text-muted-foreground">{t('weldhr.me.announcements.read')}</span>
  ) : (
    <Badge>{t('weldhr.me.announcements.new')}</Badge>
  );
}

export function MyAnnouncementsList() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrAnnouncements();
  const markAsRead = useMarkMyAnnouncementRead();
  const { open: openPanel } = useObjectPanel();
  const announcements = data?.announcements ?? [];

  // The same groups as the back office's announcements.
  const groups: GroupConfig<HrSelfAnnouncement>[] = [
    { id: 'pinned', label: t('weldhr.announcements.groups.pinned'), sortOrder: 1, filter: (a) => a.pinned },
    { id: 'other', label: t('weldhr.announcements.groups.other'), sortOrder: 2, filter: (a) => !a.pinned },
  ];

  const authors = [...new Set(announcements.map((a) => a.createdByName).filter((name): name is string => !!name))].sort();
  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.me.announcements.table.status'),
      operators: ['is'],
      options: [
        { value: 'new', label: t('weldhr.me.announcements.new') },
        { value: 'read', label: t('weldhr.me.announcements.read') },
      ],
    },
    ...(authors.length > 0
      ? [
          {
            field: 'postedBy',
            label: t('weldhr.me.announcements.table.postedBy'),
            operators: ['is'],
            options: authors.map((name) => ({ value: name, label: name })),
          },
        ]
      : []),
  ];

  const applyFilters = (rows: HrSelfAnnouncement[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'status') return list.filter((a) => (filter.value === 'new') === !a.readAt);
      if (filter.field === 'postedBy') return list.filter((a) => a.createdByName === filter.value);
      return list;
    }, rows);

  const columns: ColumnDef<HrSelfAnnouncement>[] = [
    {
      id: 'title',
      header: t('weldhr.me.announcements.table.title'),
      width: HR_COL.main,
      render: (a) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            {a.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('weldhr.me.announcements.pinned')} />}
            <p className={cn('truncate', a.readAt ? 'font-medium' : 'font-semibold')}>{a.title}</p>
          </div>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground @lg:hidden">
            <span className="tabular-nums">{formatDate(a.publishedAt)}</span>
            {!a.readAt && <AnnouncementReadState announcement={a} />}
          </div>
        </div>
      ),
    },
    {
      id: 'postedBy',
      header: t('weldhr.me.announcements.table.postedBy'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[160px]'),
      render: (a) => <span className="block truncate text-muted-foreground">{a.createdByName ?? '—'}</span>,
    },
    {
      id: 'published',
      header: t('weldhr.me.announcements.table.published'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (a) => <span className="block truncate tabular-nums text-muted-foreground">{formatDate(a.publishedAt)}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.me.announcements.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[90px]'),
      render: (a) => <AnnouncementReadState announcement={a} />,
    },
  ];

  return (
    <HrListContainer>
      <PanelEntityList<HrSelfAnnouncement>
        items={announcements}
        isLoading={isLoading}
        error={data ? null : error ? new Error(errorMessage(error, t('weldhr.me.announcements.loadFailed'))) : null}
        columns={columns}
        onRowClick={(a) => openPanel({ type: MY_ANNOUNCEMENT_PANEL_TYPE, id: a.id })}
        objectPanel={{ type: MY_ANNOUNCEMENT_PANEL_TYPE }}
        // The row's "⋮" menu (on hover): marking one as read without opening it.
        rowMenu={(a) =>
          a.readAt ? null : (
            <DropdownMenuItem onClick={() => markAsRead(a)}>
              <Check />
              {t('weldhr.me.announcements.markRead')}
            </DropdownMenuItem>
          )
        }
        groups={groups}
        filters={filters}
        applyFilters={applyFilters}
        searchFields={['title', 'body', 'createdByName']}
        searchPlaceholder={t('weldhr.me.announcements.searchPlaceholder')}
        emptyState={{
          icon: emptyIcon(Megaphone),
          title: t('weldhr.me.announcements.empty.title'),
          description: t('weldhr.me.announcements.empty.description'),
        }}
      />
    </HrListContainer>
  );
}
