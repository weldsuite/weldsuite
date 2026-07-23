import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcalendar/scheduling/[id]/edit-page';

export const Route = createFileRoute('/weldcalendar/scheduling/$id/edit/')({
  component: PageComponent,
});
