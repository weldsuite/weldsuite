import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/analytics/page';

export const Route = createFileRoute('/weldconnect/analytics/')({
  component: PageComponent,
});
