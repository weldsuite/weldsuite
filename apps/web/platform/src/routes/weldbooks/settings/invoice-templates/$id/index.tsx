import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/settings/invoice-templates/[id]/page';

export const Route = createFileRoute('/weldbooks/settings/invoice-templates/$id/')({
  component: PageComponent,
});
