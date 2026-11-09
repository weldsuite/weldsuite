import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/workload/capacity/page';

export const Route = createFileRoute('/weldflow/workload/capacity/')({
  component: PageComponent,
});
