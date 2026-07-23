import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/executions/[id]/page';

export const Route = createFileRoute('/weldconnect/executions/$id/')({
  component: PageComponent,
});
