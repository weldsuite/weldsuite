import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/page';

export const Route = createFileRoute('/weldflow/')({
  component: PageComponent,
});
