import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/task/[taskId]/page';

export const Route = createFileRoute('/weldflow/task/$taskId/')({
  component: PageComponent,
});
