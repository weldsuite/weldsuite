import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/companies/lists/page';

export const Route = createFileRoute('/weldcrm/companies/lists/')({
  component: PageComponent,
});
