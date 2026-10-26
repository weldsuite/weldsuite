import { useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { MyAnnouncementsTab } from '../components/announcements-tab';
import { MyHrPage } from '../components/my-hr-page';

/** My HR → Announcements: news from the HR team; `?announcement=<id>` (push notifications) opens that one. */
export default function MyAnnouncementsPage() {
  const t = useTranslations();
  const { announcement } = useSearch({ from: '/weldhr/me/announcements/' });

  return (
    <MyHrPage title={t('weldhr.me.pages.announcements')}>
      <MyAnnouncementsTab openId={announcement} />
    </MyHrPage>
  );
}
