import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/sequences/[id]/page';

export const Route = createFileRoute('/weldcrm/sequences/$id/')({
  component: PageComponent,
});
