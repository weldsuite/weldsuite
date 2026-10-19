import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/settings/invoice-templates/[id]/page';

export const Route = createFileRoute('/settings/entities/$id/invoice-templates/$templateId/')({
  component: PageComponent,
});
