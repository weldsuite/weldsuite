import { useTranslations } from '@weldsuite/i18n/client';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import { MY_HR_PATHS } from '../../access';
import { MyDeclarationsList } from '../components/declarations-tab';
import { useMyHrSelf } from '../components/my-hr-context';
import { useMyHrBreadcrumbs } from '../components/my-hr-page';

/** My HR → Expenses: your expense declarations, in the standard list the back office uses. */
export default function MyExpensesPage() {
  const t = useTranslations();
  const { features } = useMyHrSelf();
  useMyHrBreadcrumbs(t('weldhr.me.pages.expenses'));
  // A row opens its details panel; the URL keeps it (`?stack=`), so a link or reload reopens it.
  useObjectPanelUrlSync(MY_HR_PATHS.expenses);

  return <MyDeclarationsList canSubmit={features.declarations} />;
}
