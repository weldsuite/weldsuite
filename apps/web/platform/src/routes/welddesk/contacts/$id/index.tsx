import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/customers/[id]/page';

export const Route = createFileRoute('/welddesk/contacts/$id/')({
  component: PageComponent,
});
