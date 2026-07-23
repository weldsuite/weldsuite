import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/executions/page';

export const Route = createFileRoute('/weldconnect/executions/')({
  component: PageComponent,
});
