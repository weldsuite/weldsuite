/**
 * My HR → Time off: everything about not working, in one place. Reporting
 * sick (or recovered) comes first because it is the urgent one, then leave
 * balances and requests, then earlier sick reports.
 */

import { useTranslations } from '@weldsuite/i18n/client';
import { MyLeaveTab } from '../components/leave-tab';
import { useMyHrSelf } from '../components/my-hr-context';
import { MyHrPage } from '../components/my-hr-page';
import { SickHistoryCard, SickStatusCard } from '../components/sick-reports';

export default function MyTimeOffPage() {
  const t = useTranslations();
  const { features } = useMyHrSelf();

  return (
    <MyHrPage title={t('weldhr.me.pages.timeOff')}>
      <SickStatusCard />
      <MyLeaveTab canRequest={features.leaveRequests} />
      <SickHistoryCard />
    </MyHrPage>
  );
}
