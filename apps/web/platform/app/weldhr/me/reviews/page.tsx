import { useState } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import { MY_HR_PATHS } from '../../access';
import { HrTabsPage } from '../../components/page-kit';
import { MyKpisList, MyMilestonesList } from '../components/goals-tab';
import { useMyHrBreadcrumbs } from '../components/my-hr-page';
import { MyCoachingList, MyEvaluationsList } from '../components/reviews-tab';

type Tab = 'evaluations' | 'coaching' | 'kpis' | 'milestones';

/** My HR → Performance: evaluations and coaching to acknowledge, your KPIs and your milestones, a tab each. */
export default function MyReviewsPage() {
  const t = useTranslations();
  const [tab, setTab] = useState<Tab>('evaluations');
  useMyHrBreadcrumbs(t('weldhr.me.pages.reviews'));
  // A row opens its details panel; the URL keeps it (`?stack=`), so a link or reload reopens it.
  useObjectPanelUrlSync(MY_HR_PATHS.reviews);

  const tabs = [
    { id: 'evaluations', label: t('weldhr.me.reviews.evaluations.title') },
    { id: 'coaching', label: t('weldhr.me.reviews.coaching.title') },
    { id: 'kpis', label: t('weldhr.me.goals.kpis.title') },
    { id: 'milestones', label: t('weldhr.me.goals.milestones.title') },
  ];

  return (
    <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={(next) => setTab(next as Tab)}>
      {tab === 'evaluations' && <MyEvaluationsList />}
      {tab === 'coaching' && <MyCoachingList />}
      {tab === 'kpis' && <MyKpisList />}
      {tab === 'milestones' && <MyMilestonesList />}
    </HrTabsPage>
  );
}
