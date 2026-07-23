import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/companies/page';

export const Route = createFileRoute('/weldcrm/companies/')({
  component: PageComponent,
});
