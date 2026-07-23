import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/bills/[id]/edit/page';

export const Route = createFileRoute('/weldbooks/bills/$id/edit/')({
  component: PageComponent,
});
