import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';
import { MeetingHistoryList } from './meeting-history-list';

const HISTORY_FILTER = { page: 1, pageSize: 50, view: 'history' } as const;

export default function MeetingHistoryPage() {
  const navLabels = getTranslations('navigation').moduleSidebar.weldmeet;
  useBreadcrumbs([{ label: navLabels.history }]);

  // Full-page history: meetings that ended or ran, workspace-wide (completed,
  // failed, cancelled, or with an ended session such as instant meetings).
  // The list UI itself lives in the shared `MeetingHistoryList` so the CRM
  // panel's Meetings tab renders an identical view (just scoped to an entity).
  return <MeetingHistoryList filter={HISTORY_FILTER} />;
}
