import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmeet/$meetingId/room/page';

export const Route = createFileRoute('/weldmeet/$meetingId/room')({
  component: PageComponent,
});
