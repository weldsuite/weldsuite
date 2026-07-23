import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/analytics/builder/page';

export const Route = createFileRoute('/weldflow/analytics/builder/')({
  component: PageComponent,
});
