import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcalendar/scheduling/[id]/page';

export const Route = createFileRoute('/weldcalendar/scheduling/$id/')({
  component: PageComponent,
});
