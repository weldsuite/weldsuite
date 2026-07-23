import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/customers/page';

export const Route = createFileRoute('/welddesk/contacts/')({
  component: PageComponent,
});
