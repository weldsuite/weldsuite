import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/settings/invoice-templates/page';

export const Route = createFileRoute('/weldbooks/settings/invoice-templates/')({
  component: PageComponent,
});
