import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/analytics/[id]/page';

export const Route = createFileRoute('/weldflow/analytics/$id/')({
  component: PageComponent,
});
