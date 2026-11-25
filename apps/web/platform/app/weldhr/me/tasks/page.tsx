import { useTranslations } from '@weldsuite/i18n/client';
import { HrListContainer } from '../../components/page-kit';
import { useMyHrBreadcrumbs } from '../components/my-hr-page';
import { MyTasksTab } from '../components/tasks-tab';

/** My HR → Tasks: your onboarding / offboarding checklist tasks, as a full-width list like WeldFlow's My tasks. */
export default function MyTasksPage() {
  const t = useTranslations();
  useMyHrBreadcrumbs(t('weldhr.me.pages.tasks'));

  return (
    <HrListContainer>
      <MyTasksTab />
    </HrListContainer>
  );
}
