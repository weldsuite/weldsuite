import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/timeline/page';

export const Route = createFileRoute('/weldflow/timeline/')({
  component: PageComponent,
});
