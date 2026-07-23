import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcalendar/page';

export const Route = createFileRoute('/weldcalendar/')({
  component: PageComponent,
});
