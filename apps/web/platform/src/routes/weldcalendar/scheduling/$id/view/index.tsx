import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcalendar/scheduling/[id]/view-page';

export const Route = createFileRoute('/weldcalendar/scheduling/$id/view/')({
  component: PageComponent,
});
