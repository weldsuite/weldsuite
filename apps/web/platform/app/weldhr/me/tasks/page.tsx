import { useTranslations } from '@weldsuite/i18n/client';
import { MyHrPage } from '../components/my-hr-page';
import { MyTasksTab } from '../components/tasks-tab';

/** My HR → Tasks: your onboarding / offboarding checklist tasks. */
export default function MyTasksPage() {
  const t = useTranslations();

  return (
    <MyHrPage title={t('weldhr.me.pages.tasks')}>
      <MyTasksTab />
    </MyHrPage>
  );
}
