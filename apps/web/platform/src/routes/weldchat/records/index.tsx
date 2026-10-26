import { createFileRoute } from '@tanstack/react-router';
import RecordChatsPage from '@/app/weldchat/records/page';
import { parseRecordChatsSearch } from '@/app/weldchat/lib/record-chats-page';

export const Route = createFileRoute('/weldchat/records/')({
  validateSearch: parseRecordChatsSearch,
  component: RecordChatsPage,
});
