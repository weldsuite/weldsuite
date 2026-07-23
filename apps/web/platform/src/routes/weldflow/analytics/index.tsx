import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/analytics/page';

export const Route = createFileRoute('/weldflow/analytics/')({
  component: PageComponent,
});
