import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/customers/new/page';

export const Route = createFileRoute('/welddesk/contacts/new/')({
  component: PageComponent,
});
