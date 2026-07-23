import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/table/page';

export const Route = createFileRoute('/weldflow/table/')({
  component: PageComponent,
});
