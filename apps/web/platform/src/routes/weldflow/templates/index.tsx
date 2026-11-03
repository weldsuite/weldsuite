import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/templates/page';

export const Route = createFileRoute('/weldflow/templates/')({
  component: PageComponent,
});
