import { createFileRoute } from '@tanstack/react-router';
import DraftsPage from '@/app/weldchat/drafts/page';

export const Route = createFileRoute('/weldchat/drafts')({
  component: DraftsPage,
});
