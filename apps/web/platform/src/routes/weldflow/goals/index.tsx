import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/goals/page';

export const Route = createFileRoute('/weldflow/goals/')({
  component: PageComponent,
});
