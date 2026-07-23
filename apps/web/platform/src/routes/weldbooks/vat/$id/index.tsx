import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/vat/[id]/page';

export const Route = createFileRoute('/weldbooks/vat/$id/')({
  component: PageComponent,
});
