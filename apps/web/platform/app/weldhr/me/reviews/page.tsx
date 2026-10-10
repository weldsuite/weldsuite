/** My HR → Reviews & goals: evaluations and coaching to acknowledge, then your KPIs and milestones. */

import { useTranslations } from '@weldsuite/i18n/client';
import { MyGoalsTab } from '../components/goals-tab';
import { MyHrPage } from '../components/my-hr-page';
import { MyReviewsTab } from '../components/reviews-tab';

export default function MyReviewsPage() {
  const t = useTranslations();

  return (
    <MyHrPage title={t('weldhr.me.pages.reviews')}>
      <MyReviewsTab />
      <MyGoalsTab />
    </MyHrPage>
  );
}
