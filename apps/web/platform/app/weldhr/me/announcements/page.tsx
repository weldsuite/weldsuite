import { useEffect, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { MY_ANNOUNCEMENT_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import { MY_HR_PATHS } from '../../access';
import { MyAnnouncementsList } from '../components/announcements-tab';
import { useMyHrBreadcrumbs } from '../components/my-hr-page';

/** My HR → Announcements: news from the HR team; `?announcement=<id>` (push notifications) opens that one in its panel. */
export default function MyAnnouncementsPage() {
  const t = useTranslations();
  const { announcement } = useSearch({ from: '/weldhr/me/announcements/' });
  const { open: openPanel } = useObjectPanel();
  const openedFromLink = useRef<string | null>(null);
  useMyHrBreadcrumbs(t('weldhr.me.pages.announcements'));
  // A row opens its panel; the URL keeps it (`?stack=`), so a link or reload reopens it.
  useObjectPanelUrlSync(MY_HR_PATHS.announcements);

  // A push notification's link: open that announcement once.
  useEffect(() => {
    if (!announcement || openedFromLink.current === announcement) return;
    openedFromLink.current = announcement;
    openPanel({ type: MY_ANNOUNCEMENT_PANEL_TYPE, id: announcement });
  }, [announcement, openPanel]);

  return <MyAnnouncementsList />;
}
