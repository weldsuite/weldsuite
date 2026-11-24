/**
 * My HR → Announcements → one announcement: the whole text, who posted it and
 * when. Opening it marks it as read.
 */

import { useEffect } from 'react';
import { CalendarDays, CalendarSync, Eye, User } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useMyHrAnnouncements } from '@/hooks/queries/use-weldhr-queries';
import { MY_HR_PATHS } from '@/app/weldhr/access';
import { formatDate } from '@/app/weldhr/components/shared';
import { useMarkMyAnnouncementRead } from '@/app/weldhr/me/components/announcements-tab';
import { MY_HR_PANEL_WIDTH, MyHrPanelMenu, MyHrPanelMissing, MyHrPanelTitle, useDetailsTab } from './parts';
import { MY_ANNOUNCEMENT_PANEL_TYPE } from './types';

export function MyAnnouncementPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = useMyHrAnnouncements();
  const announcement = data?.announcements.find((a) => a.id === props.id);
  const markAsRead = useMarkMyAnnouncementRead();
  const detailsTab = useDetailsTab();

  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: isLoading && !data });

  // Opening it is reading it.
  useEffect(() => {
    if (announcement) markAsRead(announcement);
  }, [announcement, markAsRead]);

  // Edited after it went out: say when, under the publish date.
  const edited = announcement && announcement.updatedAt.slice(0, 10) !== announcement.publishedAt.slice(0, 10);

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        <MyHrPanelTitle
          label={announcement?.title}
          status={announcement?.pinned ? <Badge variant="outline">{t('weldhr.me.announcements.pinned')}</Badge> : null}
        />
      }
      actions={
        announcement ? (
          <MyHrPanelMenu listPath={MY_HR_PATHS.announcements} type={MY_ANNOUNCEMENT_PANEL_TYPE} id={announcement.id} />
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {!announcement && <MyHrPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {announcement && (
        <div className="space-y-4 p-4">
          <div className="space-y-1">
            <PanelRow icon={User} label={t('weldhr.me.announcements.table.postedBy')} value={announcement.createdByName} />
            <PanelRow
              icon={CalendarDays}
              label={t('weldhr.me.announcements.table.published')}
              value={formatDate(announcement.publishedAt)}
              tabular
            />
            {edited && (
              <PanelRow
                icon={CalendarSync}
                label={t('weldhr.me.announcements.panel.updated')}
                value={formatDate(announcement.updatedAt)}
                tabular
              />
            )}
            <PanelRow
              icon={Eye}
              label={t('weldhr.me.announcements.panel.readOn')}
              value={announcement.readAt ? formatDate(announcement.readAt) : null}
              tabular
            />
          </div>
          {/* Plain text from HR: keep its line breaks, never render it as markup. */}
          <p className="whitespace-pre-wrap break-words border-t pt-4 text-sm leading-relaxed text-foreground">
            {announcement.body}
          </p>
        </div>
      )}
    </EntityDetailView>
  );
}
