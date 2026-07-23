import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/workload/page';

export const Route = createFileRoute('/weldflow/workload/')({
  component: PageComponent,
});
