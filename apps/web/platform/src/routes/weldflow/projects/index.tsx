import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/projects/page';

export const Route = createFileRoute('/weldflow/projects/')({
  component: PageComponent,
});
