import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/intake/roadmap/page';

export const Route = createFileRoute('/weldflow/intake/roadmap/')({
  component: PageComponent,
});
