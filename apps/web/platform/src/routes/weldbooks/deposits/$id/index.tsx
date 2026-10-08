import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/deposits/[id]/page';

export const Route = createFileRoute('/weldbooks/deposits/$id/')({
  component: PageComponent,
});
