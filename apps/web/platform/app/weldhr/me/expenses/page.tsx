/** My HR → Expenses: your expense declarations. */

import { useTranslations } from '@weldsuite/i18n/client';
import { MyDeclarationsTab } from '../components/declarations-tab';
import { useMyHrSelf } from '../components/my-hr-context';
import { MyHrPage } from '../components/my-hr-page';

export default function MyExpensesPage() {
  const t = useTranslations();
  const { features } = useMyHrSelf();

  return (
    <MyHrPage title={t('weldhr.me.pages.expenses')}>
      <MyDeclarationsTab canSubmit={features.declarations} />
    </MyHrPage>
  );
}
