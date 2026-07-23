import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/bills/[id]/page';

export const Route = createFileRoute('/weldbooks/bills/$id/')({
  component: PageComponent,
});
