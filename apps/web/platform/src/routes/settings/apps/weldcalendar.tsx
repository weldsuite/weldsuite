import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldcalendar/page';

export const Route = createFileRoute('/settings/apps/weldcalendar')({
  component: PageComponent,
});
