import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/capacity/page';

export const Route = createFileRoute('/weldflow/capacity/')({
  component: PageComponent,
});
