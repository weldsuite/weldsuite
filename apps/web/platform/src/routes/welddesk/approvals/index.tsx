import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/approvals/page';

export const Route = createFileRoute('/welddesk/approvals/')({
  component: PageComponent,
});
