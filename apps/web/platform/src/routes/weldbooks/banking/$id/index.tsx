import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/[id]/page';

export const Route = createFileRoute('/weldbooks/banking/$id/')({
  component: PageComponent,
});
