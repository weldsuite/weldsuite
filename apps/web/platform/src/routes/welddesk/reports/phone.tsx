import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/analytics/phone/page';

export const Route = createFileRoute('/welddesk/reports/phone')({
  component: PageComponent,
});
