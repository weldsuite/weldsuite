import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/settings/invoice-templates/page';

export const Route = createFileRoute('/settings/entities/$id/invoice-templates/')({
  component: PageComponent,
});
