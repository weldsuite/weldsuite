import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcalendar/scheduling/page';

export const Route = createFileRoute('/preview/weldcalendar/scheduling/')({
  component: PageComponent,
});
