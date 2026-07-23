import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/companies/lists/[id]/page';

export const Route = createFileRoute('/weldcrm/companies/lists/$id/')({
  component: PageComponent,
});
