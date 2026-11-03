import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/reviews/page';

export const Route = createFileRoute('/weldflow/reviews/')({
  component: PageComponent,
});
