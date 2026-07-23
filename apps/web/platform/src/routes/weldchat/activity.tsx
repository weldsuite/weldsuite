import { createFileRoute } from '@tanstack/react-router';
import ActivityPage from '@/app/weldchat/activity/page';

export const Route = createFileRoute('/weldchat/activity')({
  component: ActivityPage,
});
