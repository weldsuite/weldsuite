import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/bi-connector/page';

export const Route = createFileRoute('/welddesk/reports/bi-connector')({
  component: PageComponent,
});
