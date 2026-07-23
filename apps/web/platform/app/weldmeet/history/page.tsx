import { MeetingHistoryList } from './meeting-history-list';

export default function MeetingHistoryPage() {
  // Full-page history: completed / failed / cancelled meetings workspace-wide.
  // The list UI itself lives in the shared `MeetingHistoryList` so the CRM
  // panel's Meetings tab renders an identical view (just scoped to an entity).
  return <MeetingHistoryList filter={{ page: 1, pageSize: 50, status: 'completed,failed,cancelled' }} />;
}
