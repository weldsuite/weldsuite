import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmeet/$meetingId/page';

export const Route = createFileRoute('/weldmeet/$meetingId/')({
  component: PageComponent,
});
