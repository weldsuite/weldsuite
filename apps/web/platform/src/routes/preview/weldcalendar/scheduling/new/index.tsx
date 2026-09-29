import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcalendar/scheduling/new/page';

export const Route = createFileRoute('/preview/weldcalendar/scheduling/new/')({
  component: PageComponent,
});
