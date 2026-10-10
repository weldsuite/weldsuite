/** My HR → Schedule & hours: your shifts and clock records. */

import { useTranslations } from '@weldsuite/i18n/client';
import { MyAttendanceTab } from '../components/attendance-tab';
import { MyHrPage } from '../components/my-hr-page';

export default function MySchedulePage() {
  const t = useTranslations();

  return (
    <MyHrPage title={t('weldhr.me.pages.schedule')}>
      <MyAttendanceTab />
    </MyHrPage>
  );
}
