import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/intake/page';

export const Route = createFileRoute('/weldflow/intake/')({
  component: PageComponent,
});
