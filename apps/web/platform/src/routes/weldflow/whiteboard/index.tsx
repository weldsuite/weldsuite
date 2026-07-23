import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/whiteboard/page';

export const Route = createFileRoute('/weldflow/whiteboard/')({
  component: PageComponent,
});
